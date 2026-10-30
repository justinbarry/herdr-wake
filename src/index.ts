// herdr-wake: wake this omp session when watched herdr panes change agent state.
//
// Armed per process with `omp --herdr-wake`; inert otherwise (and outside herdr). Pure extension:
// it talks to herdr's socket directly and needs no omp or herdr changes. It advertises a display-only
// `herdr_wake: "manager"` pane token while armed (and clears it on shutdown) so peer managers in the
// same repo skip each other; herdr's own omp lifecycle integration is unaffected.
//
// Flow: herdr socket `events.subscribe` -> per-pane queue -> debounce -> `pi.sendMessage`.
// Settled (idle/done) updates wait in the queue while this session is mid-turn (or while the user is
// typing in the composer, reviewing a plan, or within the 15s post-Esc abort cooldown) and go out as
// one batched wake once free; `blocked` alerts are injected at the next step boundary (`aside`);
// panes watched with `mode: "digest"` ride along on the next turn instead of starting one. Queued
// entries are re-checked against live `agent.list` before they spend a turn, and the wake rate cap
// defers queued updates instead of dropping them.
// The wake text is status-only (pane ids, transitions, live working duration, focus flag). Pane text
// is untrusted and is never injected; the model reads it itself (`herdr agent read`) and may delegate
// heavy inspection to `task`.
//
// Scope: other non-manager agent panes in this workspace and in the rest of its worktree group: the
// primary workspace and its linked-worktree workspaces, i.e. every workspace on the same repo. Watch
// settings, mutes, and the `/herdr auto` cadence persist in the session across `--resume`.
//
// `/herdr` lists the open agent panes and how they are watched (local, no model turn);
// `/herdr mute <pane>` and `/herdr unmute <pane>` silence or restore panes;
// `/herdr check` submits the snapshot with a review prompt (check.md) to the model;
// `/herdr auto [interval|off]` reviews only unreviewed completed/blocked transitions on a cadence.
import net from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { formatDuration, prompt } from "@oh-my-pi/pi-utils";
import checkTemplate from "./prompts/check.md" with { type: "text" };
import managerGuidance from "./prompts/manager.md" with { type: "text" };
import statusTemplate from "./prompts/status.md" with { type: "text" };
import wakeTemplate from "./prompts/wake.md" with { type: "text" };

const FLAG = "herdr-wake";
const STATUS_KEY = "herdr-wake";
const WIDGET_KEY = "herdr-wake";
const WAKE_TYPE = "herdr-wake";
const STATE_ENTRY_TYPE = "herdr-wake-state";
const MANAGER_TOKEN = "herdr_wake";

const DEBOUNCE_MS = 750; // coalesce flapping panes into one wake
const IDLE_SETTLE_MS = 100; // wait for AgentSession.#endInFlight() after agent_end
const IDLE_POLL_MS = 1_000; // backup poll while settled wakes wait for manager idle
const ABORT_COOLDOWN_MS = 15_000; // yield to the user after Esc / cancelled ask before firing idle wakes
const REFRESH_DEBOUNCE_MS = 200; // coalesce pane lifecycle bursts into one resync
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15_000;
const WAKE_WINDOW_MS = 10 * 60_000; // circuit breaker: agent <-> agent ping-pong guard
const WAKE_CAP = 20;
const REQUEST_TIMEOUT_MS = 3_000;
const SHUTDOWN_TIMEOUT_MS = 250;
const AUTO_DEFAULT_MS = 10 * 60_000; // `/herdr auto` without an interval
const AUTO_MIN_MS = 60_000; // every tick can cost a model turn
const AUTO_MAX_MS = 24 * 3_600_000;
const INLINE_WORK_NUDGE_AT = 3; // inline research/work calls in one manager turn before nudging to spawn a herdr session
const ORCHESTRATION_TOOLS: Record<string, true> = { herdr_watch: true, ask: true, wait: true, todo: true };
const HERDR_CMD_RE = /\bherdr\b/;
const HERDR_DISPATCH_RE = /\bherdr\s+(?:worktree\s+create|agent\s+(?:start|prompt)|pane\s+(?:split|run|send))/;
const INLINE_DRIFT_NUDGE =
	"[herdr-wake] You have run multiple inline research/inspection calls in the manager session this turn without dispatching a worker. " +
	"Unless the user explicitly asked you to run this inline here, stop pre-investigating in the manager: spin up a herdr worktree session now " +
	"(`herdr worktree create --branch <name> --no-focus`, `herdr agent start`, `herdr agent prompt` without `--wait`) with a thin brief from what " +
	"you already know, and let that worker session do the code, DB, log, or PR investigation and fix.";

// Lifecycle events that change which panes/workspaces exist or which are agents. The server
// also names some of them with an underscore (`pane_created`), so names are normalized below.
const LIFECYCLE = [
	"pane.created",
	"pane.closed",
	"pane.exited",
	"pane.moved",
	"pane.agent_detected",
	"workspace.created",
	"workspace.renamed",
	"workspace.closed",
	"worktree.created",
	"worktree.opened",
	"worktree.removed",
];
type Known = "working" | "idle" | "done" | "blocked";
const KNOWN: ReadonlySet<string> = new Set(["working", "idle", "done", "blocked"]);
const DEFAULT_UNTIL: ReadonlySet<string> = new Set(["idle", "done", "blocked"]);
type TimerHandle = Parameters<ExtensionContext["clearTimer"]>[0];
type SendOptions = Parameters<ExtensionAPI["sendMessage"]>[1];

type WatchMode = "wake" | "digest";
/** wake: starts a turn; aside: injected mid-turn; digest: rides along on the next turn. */
type Delivery = "wake" | "aside" | "digest";

interface PendingWake {
	from: Known | "unknown";
	to: Known;
	/** Time spent in `working` before this transition, when observed live. */
	workedMs?: number;
	/** Bumped on every observed transition; tells a flush whether an event landed while it awaited. */
	gen: number;
}

interface WakeRow {
	pane: string;
	label: string;
	workspace: string | undefined;
	from: Known | "unknown";
	to: Known;
	worked?: string;
	focused?: boolean;
	meta?: string;
}

interface PaneStatus {
	pane: string;
	label: string;
	workspace: string | undefined;
	status: string;
	focused?: boolean;
	watch: string;
	queued: string | undefined;
}

interface ReviewedPane {
	state: "settled" | "blocked";
	completionSeq?: number;
	stateChangeSeq?: number;
}

interface PersistedWatch {
	pane: string;
	until: Known[];
	mode?: WatchMode;
}

interface PersistedState {
	v: 1;
	autoMs: number;
	muted: string[];
	watches: PersistedWatch[];
}

// A type alias, not an interface: prompt.render needs the implicit string index signature.
type HerdrSnapshot = {
	agents: number;
	watched: number;
	queued: number;
	throttled: boolean;
	panes: PaneStatus[];
};

const DELIVERY_OPTIONS: Record<Delivery, SendOptions> = {
	// followUp: queue behind a running turn instead of steering it; triggerTurn starts one when idle.
	wake: { triggerTurn: true, deliverAs: "followUp" },
	aside: { deliverAs: "aside" },
	digest: { triggerTurn: false, deliverAs: "nextTurn" },
};

// Standing manager preference, added to the system prompt only while armed (see before_agent_start).
// It deliberately overrides the herdr skill's "sibling pane, no new worktree" default: the user asked for it.
const WORKTREE_GUIDE = managerGuidance.trim();

const socketPath = process.env.HERDR_SOCKET_PATH;
const endpoint = process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
const selfPane = process.env.HERDR_PANE_ID;
// omp marks every shell it spawns with OMPCODE=1; a nested omp must not arm over its parent.
const insideHerdr = process.env.HERDR_ENV === "1" && !!endpoint && !!selfPane && process.env.OMPCODE !== "1";

interface AgentRow {
	pane_id: string;
	workspace_id?: string;
	agent_status?: string;
	/** Live agent name when one was assigned. */
	name?: string;
	/** Detected agent kind; `herdr_watch` matches it only when exactly one pane runs it. */
	agent?: string;
	/** What wake messages show: the name when assigned, else the kind. */
	label?: string;
	focused?: boolean;
	completion_seq?: number;
	state_change_seq?: number;
	tokens?: Record<string, string>;
}

interface Sub {
	close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Agent names, kinds and workspace labels are set by whoever controls the pane (`herdr pane
 * report-agent --agent <LABEL>`) or the branch, and they reach model-facing wake text. Keep
 * them to a short identifier: no whitespace, newlines or markup.
 */
function safeLabel(value: unknown, max = 32): string | undefined {
	const text = str(value);
	return text ? text.replace(/[^\w./-]/g, "_").slice(0, max) : undefined;
}

function parse(line: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function tokenMap(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	let out: Record<string, string> | undefined;
	for (const [k, v] of Object.entries(value)) {
		if (typeof v === "string") {
			out ??= {};
			out[k] = v;
		}
	}
	return out;
}

function toAgentRow(value: unknown): AgentRow | undefined {
	if (!isRecord(value)) return undefined;
	const pane_id = str(value.pane_id);
	if (!pane_id) return undefined;
	const name = safeLabel(value.name);
	const agent = safeLabel(value.agent);
	return {
		pane_id,
		workspace_id: str(value.workspace_id),
		agent_status: str(value.agent_status),
		name,
		agent,
		label: name ?? agent,
		focused: typeof value.focused === "boolean" ? value.focused : undefined,
		completion_seq:
			typeof value.completion_seq === "number" && Number.isInteger(value.completion_seq) && value.completion_seq >= 0
				? value.completion_seq
				: undefined,
		state_change_seq:
			typeof value.state_change_seq === "number" &&
			Number.isInteger(value.state_change_seq) &&
			value.state_change_seq >= 0
				? value.state_change_seq
				: undefined,
		tokens: tokenMap(value.tokens),
	};
}

function errorText(error: unknown, fallback: string): string {
	if (!isRecord(error)) return fallback;
	return `${str(error.code) ?? "error"}: ${str(error.message) ?? fallback}`;
}

/** Splits a socket stream into NDJSON lines. */
function lines(onLine: (line: string) => void): (chunk: string) => void {
	let buf = "";
	return chunk => {
		buf += chunk;
		for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			if (line) onLine(line);
		}
	};
}

let reqSeq = 0;

/** One request, one reply, then the connection is dropped. */
function request(
	method: string,
	params: Record<string, unknown> = {},
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
	const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
	const id = `${WAKE_TYPE}:${++reqSeq}`;
	const socket = net.createConnection(endpoint!);
	socket.setEncoding("utf8");
	let done = false;
	const finish = (err?: Error, value?: Record<string, unknown>) => {
		if (done) return;
		done = true;
		clearTimeout(timer);
		socket.destroy();
		if (err) reject(err);
		else resolve(value ?? {});
	};
	const timer = setTimeout(() => finish(new Error(`${method} timed out`)), timeoutMs);
	timer.unref?.();
	socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
	socket.on(
		"data",
		lines(line => {
			const msg = parse(line);
			if (!msg || msg.id !== id) return;
			if (msg.error !== undefined) finish(new Error(errorText(msg.error, method)));
			else finish(undefined, isRecord(msg.result) ? msg.result : {});
		}),
	);
	socket.on("error", e => finish(e));
	socket.on("close", () => finish(new Error(`${method}: connection closed`)));
	return promise;
}

/**
 * Long-lived `events.subscribe`. Resolves once herdr acks `subscription_started`.
 * `onClose` fires only for unexpected loss (error, events_lost, server gone), never
 * for a `close()` the caller asked for. Callbacks run from socket events, so callers
 * must pass handlers that cannot throw.
 */
function subscribe(
	subscriptions: unknown[],
	onEvent: (name: string, data: unknown) => void,
	onClose: (reason: string) => void,
): Promise<Sub> {
	const { promise, resolve, reject } = Promise.withResolvers<Sub>();
	const id = `${WAKE_TYPE}:sub:${++reqSeq}`;
	const socket = net.createConnection(endpoint!);
	socket.setEncoding("utf8");
	let acked = false;
	let closed = false;
	const fail = (reason: string) => {
		if (closed) return;
		closed = true;
		clearTimeout(timer);
		socket.destroy();
		if (acked) onClose(reason);
		else reject(new Error(reason));
	};
	const timer = setTimeout(() => fail("subscribe ack timed out"), REQUEST_TIMEOUT_MS);
	timer.unref?.();
	socket.on("connect", () =>
		socket.write(`${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } })}\n`),
	);
	socket.on(
		"data",
		lines(line => {
			const msg = parse(line);
			if (!msg || closed) return;
			if (msg.error !== undefined) {
				fail(errorText(msg.error, "subscription error"));
				return;
			}
			if (!acked) {
				if (msg.id === id && isRecord(msg.result) && msg.result.type === "subscription_started") {
					acked = true;
					clearTimeout(timer);
					resolve({
						close() {
							if (closed) return;
							closed = true;
							socket.destroy();
						},
					});
				}
				return;
			}
			const name = str(msg.event);
			if (name) onEvent(name, msg.data);
		}),
	);
	socket.on("error", e => fail(e.message));
	socket.on("close", () => fail("connection closed"));
	return promise;
}

/** `90s`, `10m`, `2h`; a bare number is minutes. */
function parseInterval(text: string): number | undefined {
	const match = /^(\d+)([smh])?$/.exec(text);
	if (!match) return undefined;
	const unit = match[2] === "s" ? 1_000 : match[2] === "h" ? 3_600_000 : 60_000;
	return Number(match[1]) * unit;
}

export default function herdrWake(pi: ExtensionAPI) {
	pi.registerFlag(FLAG, {
		type: "boolean",
		description: "Listen to herdr agent-state events and wake this session (herdr panes only)",
	});

	registerHerdrCommand();

	const z = pi.zod;

	let ctxRef: ExtensionContext | undefined;
	let running = false;
	let stopped = true;

	let conn: Sub | undefined;
	let connGen = 0;
	let subscribedKey = "";
	let watchedSet: ReadonlySet<string> = new Set();
	let workspaceId = process.env.HERDR_WORKSPACE_ID;
	let scopeWarned = false;

	const lastKnown = new Map<string, Known>();
	const workingSince = new Map<string, number>();
	const lastCompletionSeq = new Map<string, number>();
	const lastStateSeq = new Map<string, number>();
	const lastFocused = new Map<string, boolean>();
	const lastEventSeq = new Map<string, number>();
	const labels = new Map<string, string>();
	const explicit = new Map<string, ReadonlySet<string>>(); // pane id -> states that wake
	const muted = new Set<string>();
	const blockedPanes = new Set<string>(); // watched panes blocked right now, oldest first; drives the alert widget

	const explicitMode = new Map<string, WatchMode>(); // pane id -> "digest" (omitted = "wake")
	const pending = new Map<string, PendingWake>();
	let pendingSeq = 0;
	let flushDueAt = 0;
	let abortHoldUntil = 0;
	let throttled = false;
	let flushing = false;
	let flushAgain = false;
	let autoMs = 0; // `/herdr auto` cadence; 0 = off
	let autoTimer: TimerHandle | undefined;
	let autoDueAt = 0; // next tick
	let autoGen = 0; // bumped on every on/off/shutdown: an in-flight tick from an older schedule must not dispatch
	const autoReviewed = new Map<string, ReviewedPane>(); // per-pane reviewed state so unchanged/event-delivered panes do not re-trigger auto
	let wakeTimes: number[] = [];
	let capNotified = false;
	let inlineCalls = 0;
	let delegatedThisTurn = false;
	let nudgedThisTurn = false;

	let refreshing = false;
	let dirty = false;
	let backoffMs = BACKOFF_BASE_MS;
	let flushTimer: TimerHandle | undefined;
	let refreshTimer: TimerHandle | undefined;
	let retryTimer: TimerHandle | undefined;
	/** workspace id -> git/worktree facts from session.snapshot / workspace.list */
	const workspaces = new Map<string, { repoKey?: string; label?: string }>();
	const paneWorkspace = new Map<string, string>();
	function logWarn(msg: string, extra?: Record<string, unknown>): void {
		try {
			pi.logger.warn(`herdr-wake: ${msg}`, extra);
		} catch {
			// logging must never take the session down
		}
	}

	/** Wraps a callback that runs from a socket event: a throw there would kill the session. */
	function guarded<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
		return (...args) => {
			try {
				fn(...args);
			} catch (e) {
				logWarn("handler threw", { error: String(e) });
			}
		};
	}

	// Managed timers: a throw is contained and every timer is cleared on session_shutdown.
	function setTimer(fn: () => void, ms: number): TimerHandle {
		return ctxRef!.setTimeout(fn, ms);
	}

	function clearTimer(handle: TimerHandle | undefined): void {
		if (handle !== undefined) ctxRef?.clearTimer(handle);
	}

	/** One flush timer. `shorten` lets an earlier deadline replace a later one; never the reverse. */
	function scheduleFlush(delayMs: number, shorten = false): void {
		if (stopped) return;
		const due = Date.now() + delayMs;
		if (flushTimer !== undefined) {
			if (!shorten || due >= flushDueAt) return;
			clearTimer(flushTimer);
		}
		flushDueAt = due;
		flushTimer = setTimer(() => {
			flushTimer = undefined;
			flushDueAt = 0;
			void flush();
		}, delayMs);
	}

	function updateStatus(): void {
		try {
			let text: string | undefined;
			if (running) {
				text = `herdr-wake: ${watchedSet.size} pane(s)`;
				if (pending.size > 0) text += `, ${pending.size} queued${throttled ? " (throttled)" : ""}`;
				if (autoMs > 0) text += `, auto ${formatDuration(autoMs)}`;
			}
			ctxRef?.ui.setStatus(STATUS_KEY, text);
		} catch {
			// status is cosmetic
		}
	}

	/**
	 * The blocked-pane alert: a widget above the editor plus a notice when a pane blocks. It comes
	 * straight from herdr's event, so it never waits on the model, an idle session or a wake slot.
	 */
	function showBlocked(): void {
		try {
			let lines: string[] | undefined;
			if (running && blockedPanes.size > 0) {
				const shown = [...blockedPanes].slice(0, 3).map(p => `${p} (${labels.get(p) ?? "agent"})`);
				const more = blockedPanes.size > shown.length ? ` +${blockedPanes.size - shown.length} more` : "";
				lines = [`herdr-wake: ${blockedPanes.size} blocked: ${shown.join(", ")}${more}. /herdr focus jumps to the first.`];
			}
			ctxRef?.ui.setWidget(WIDGET_KEY, lines);
		} catch {
			// the widget is cosmetic
		}
	}

	/**
	 * Whether other watched panes are working or have updates queued. A pending `ask` parks this
	 * session on the user, so the wake text only asks for it when nothing else needs the session.
	 */
	function othersBusy(): boolean {
		if (pending.size > 0) return true;
		for (const [pane, status] of lastKnown) if (status === "working" && watchedSet.has(pane)) return true;
		return false;
	}

	/** Non-zero while an idle session should yield to the user (post-Esc cooldown, composer draft, or plan review). */
	function userHoldMs(now: number): number {
		if (now < abortHoldUntil) return Math.max(IDLE_SETTLE_MS, abortHoldUntil - now);
		try {
			const draft = ctxRef?.ui.getEditorText?.();
			if (typeof draft === "string" && draft.trim().length > 0) return IDLE_POLL_MS;
			if (ctxRef?.getPendingPlanReview?.() !== undefined) return IDLE_POLL_MS;
		} catch {
			// optional host UI hooks must never break wake delivery
		}
		return 0;
	}

	function wasTurnAborted(event: unknown): boolean {
		if (!isRecord(event) || !Array.isArray(event.messages)) return false;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const msg = event.messages[i];
			if (isRecord(msg) && msg.role === "assistant") {
				return msg.stopReason === "aborted";
			}
		}
		return false;
	}

	function persistState(): void {
		try {
			const watches: PersistedWatch[] = [];
			for (const [pane, until] of explicit) {
				const states = [...until].filter((s): s is Known => DEFAULT_UNTIL.has(s));
				if (states.length === 0) continue;
				const mode = explicitMode.get(pane);
				watches.push(mode === "digest" ? { pane, until: states, mode } : { pane, until: states });
			}
			const data: PersistedState = {
				v: 1,
				autoMs,
				muted: [...muted].sort(),
				watches,
			};
			pi.appendEntry?.(STATE_ENTRY_TYPE, data);
		} catch (e) {
			logWarn("could not persist state", { error: String(e) });
		}
	}

	function restoreState(ctx: ExtensionContext): void {
		let entries: readonly unknown[] | undefined;
		try {
			entries = ctx.sessionManager?.getBranch?.();
		} catch {
			return;
		}
		if (!Array.isArray(entries)) return;
		let saved: Record<string, unknown> | undefined;
		for (const entry of entries) {
			if (isRecord(entry) && entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE && isRecord(entry.data)) {
				saved = entry.data;
			}
		}
		muted.clear();
		explicit.clear();
		explicitMode.clear();
		let nextAutoMs = 0;
		if (saved) {
			if (
				typeof saved.autoMs === "number" &&
				(saved.autoMs === 0 || (saved.autoMs >= AUTO_MIN_MS && saved.autoMs <= AUTO_MAX_MS))
			) {
				nextAutoMs = saved.autoMs;
			}
			if (Array.isArray(saved.muted)) {
				for (const item of saved.muted) {
					const pane = str(item);
					if (pane && pane !== selfPane) muted.add(pane);
				}
			}
			if (Array.isArray(saved.watches)) {
				for (const item of saved.watches) {
					if (!isRecord(item)) continue;
					const pane = str(item.pane);
					if (!pane || pane === selfPane || muted.has(pane)) continue;
					const untilArr = Array.isArray(item.until)
						? item.until.filter((s): s is string => typeof s === "string" && DEFAULT_UNTIL.has(s))
						: [];
					explicit.set(pane, untilArr.length > 0 ? new Set(untilArr) : DEFAULT_UNTIL);
					if (item.mode === "digest") explicitMode.set(pane, "digest");
				}
			}
		}
		for (const pane of muted) {
			pending.delete(pane);
			blockedPanes.delete(pane);
			autoReviewed.delete(pane);
		}
		if (nextAutoMs !== autoMs || (nextAutoMs > 0 && autoTimer === undefined)) {
			autoMs = nextAutoMs;
			autoGen++;
			autoReviewed.clear();
			scheduleAuto();
		}
		showBlocked();
		updateStatus();
	}

	function parseAgents(raw: unknown): AgentRow[] {
		if (!Array.isArray(raw)) return [];
		const rows: AgentRow[] = [];
		for (const item of raw) {
			const row = toAgentRow(item);
			if (row) rows.push(row);
		}
		return rows;
	}

	function applyWorkspaces(raw: unknown): void {
		if (!Array.isArray(raw)) return;
		workspaces.clear();
		for (const item of raw) {
			if (!isRecord(item)) continue;
			const id = str(item.workspace_id);
			if (!id) continue;
			const worktree = isRecord(item.worktree) ? item.worktree : undefined;
			workspaces.set(id, {
				repoKey: worktree ? str(worktree.repo_key) : undefined,
				label: safeLabel(item.label, 48),
			});
		}
	}

	async function listAgents(): Promise<AgentRow[]> {
		const result = await request("agent.list");
		return parseAgents(result.agents);
	}

	/** Resolves this pane's workspace and the git/worktree facts of every workspace (fallback when session.snapshot is absent). */
	async function ensureScope(): Promise<void> {
		if (!workspaceId) {
			const pane = await request("pane.get", { pane_id: selfPane });
			const info = isRecord(pane.pane) ? pane.pane : pane;
			workspaceId = str(info.workspace_id);
			if (!workspaceId && !scopeWarned) {
				scopeWarned = true;
				logWarn("could not resolve this pane's workspace; only explicit watches apply");
			}
		}
		const result = await request("workspace.list");
		applyWorkspaces(result.workspaces);
	}

	/** Reads workspaces, pane scope, and live agents in one `session.snapshot` call when supported. */
	async function readClusterState(): Promise<AgentRow[]> {
		try {
			const result = await request("session.snapshot");
			const snap = isRecord(result.snapshot) ? result.snapshot : result;
			if (Array.isArray(snap.agents) && Array.isArray(snap.workspaces)) {
				applyWorkspaces(snap.workspaces);
				if (!workspaceId && Array.isArray(snap.panes)) {
					for (const item of snap.panes) {
						if (isRecord(item) && item.pane_id === selfPane) {
							workspaceId = str(item.workspace_id);
							break;
						}
					}
				}
				if (!workspaceId) {
					for (const item of snap.agents) {
						if (isRecord(item) && item.pane_id === selfPane) {
							workspaceId = str(item.workspace_id);
							break;
						}
					}
				}
				if (!workspaceId && !scopeWarned) {
					scopeWarned = true;
					logWarn("could not resolve this pane's workspace; only explicit watches apply");
				}
				return parseAgents(snap.agents);
			}
		} catch {
			// fall back to workspace.list + agent.list on older or minimal servers
		}
		await ensureScope();
		return await listAgents();
	}

	/**
	 * This workspace, plus the rest of its worktree group: every workspace on the same repo (the
	 * primary workspace and its linked-worktree workspaces). Other repos stay out.
	 */
	function inScope(workspace: string | undefined): boolean {
		if (!workspace || !workspaceId) return false;
		if (workspace === workspaceId) return true;
		const mine = workspaces.get(workspaceId)?.repoKey;
		return mine !== undefined && workspaces.get(workspace)?.repoKey === mine;
	}

	/** The workspace a pane lives in, for wake text; none for the manager's own workspace. */
	function workspaceLabel(pane: string): string | undefined {
		const id = paneWorkspace.get(pane);
		return id && id !== workspaceId ? workspaces.get(id)?.label : undefined;
	}

	function desired(agents: AgentRow[]): string[] {
		const out: string[] = [];
		for (const a of agents) {
			if (a.pane_id === selfPane || muted.has(a.pane_id)) continue;
			if (explicit.has(a.pane_id) || (a.tokens?.[MANAGER_TOKEN] !== "manager" && inScope(a.workspace_id))) {
				out.push(a.pane_id);
			}
		}
		return out.sort();
	}

	function recordRowFacts(a: AgentRow): void {
		if (a.label) labels.set(a.pane_id, a.label);
		if (a.workspace_id) paneWorkspace.set(a.pane_id, a.workspace_id);
		if (a.completion_seq !== undefined) lastCompletionSeq.set(a.pane_id, a.completion_seq);
		if (a.state_change_seq !== undefined) lastStateSeq.set(a.pane_id, a.state_change_seq);
		if (a.focused !== undefined) lastFocused.set(a.pane_id, a.focused);
	}

	function normReviewState(status: string | undefined): "settled" | "blocked" | undefined {
		if (status === "idle" || status === "done") return "settled";
		if (status === "blocked") return "blocked";
		return undefined;
	}

	function markReviewed(pane: string, status: string | undefined, row?: AgentRow): void {
		const state = normReviewState(status);
		if (!state) return;
		if (status && KNOWN.has(status)) {
			lastKnown.set(pane, status as Known);
			workingSince.delete(pane);
		}
		autoReviewed.set(pane, {
			state,
			completionSeq: row?.completion_seq ?? lastCompletionSeq.get(pane),
			stateChangeSeq: row?.state_change_seq ?? lastStateSeq.get(pane),
		});
	}

	function isAlreadyReviewed(row: AgentRow): boolean {
		const state = normReviewState(row.agent_status);
		if (!state) return true;
		const prev = autoReviewed.get(row.pane_id);
		if (!prev || prev.state !== state) return false;
		if (state === "settled") {
			if (row.completion_seq !== undefined && prev.completionSeq !== undefined) {
				return row.completion_seq === prev.completionSeq;
			}
			return true;
		}
		if (row.state_change_seq !== undefined && prev.stateChangeSeq !== undefined) {
			return row.state_change_seq === prev.stateChangeSeq;
		}
		return true;
	}

	/**
	 * `fromSnapshot` first-sights are baseline only (never wake on arming); anything else
	 * is a live event. Wakes: working -> idle|done, or anything -> blocked.
	 */
	function observe(paneId: string, status: string | undefined, fromSnapshot: boolean): void {
		if (!status || paneId === selfPane || !KNOWN.has(status)) return; // `unknown` flickers between states
		const eventGen = fromSnapshot ? undefined : ++pendingSeq;
		if (eventGen !== undefined) lastEventSeq.set(paneId, eventGen);
		const next = status as Known;
		const prev = lastKnown.get(paneId);
		lastKnown.set(paneId, next);
		if (next === "blocked" && watchedSet.has(paneId) && (explicit.get(paneId) ?? DEFAULT_UNTIL).has("blocked")) {
			if (!blockedPanes.has(paneId)) {
				blockedPanes.add(paneId);
				showBlocked();
				if (!fromSnapshot) {
					const who = `${paneId} (${labels.get(paneId) ?? "agent"})`;
					ctxRef?.ui.notify(`herdr-wake: ${who} is blocked and waiting on you. /herdr focus jumps to it.`, "warning");
				}
			}
		} else if (blockedPanes.delete(paneId)) {
			showBlocked();
		}
		if (next === "working") {
			if (prev !== "working" && !(fromSnapshot && prev === undefined)) {
				workingSince.set(paneId, Date.now());
			}
			autoReviewed.delete(paneId);
			// went back to work before the wake fired: stale
			if (pending.delete(paneId)) {
				if (pending.size === 0) {
					clearTimer(flushTimer);
					flushTimer = undefined;
					flushDueAt = 0;
					throttled = false;
				}
				updateStatus();
			}
			return;
		}
		let workedMs: number | undefined;
		if (prev === "working") {
			const started = workingSince.get(paneId);
			workingSince.delete(paneId);
			if (started !== undefined) workedMs = Math.max(0, Date.now() - started);
		} else if (!fromSnapshot) {
			workingSince.delete(paneId);
		}
		if (fromSnapshot && prev === undefined) return;
		if (!watchedSet.has(paneId)) return;
		const until = explicit.get(paneId) ?? DEFAULT_UNTIL;
		const settled = next === "idle" || next === "done";
		const fire = until.has(next) && ((settled && prev === "working") || (next === "blocked" && prev !== "blocked"));
		if (!fire) return;
		const held = pending.get(paneId);
		pending.set(paneId, {
			from: held?.from ?? prev ?? "unknown",
			to: next,
			workedMs: workedMs ?? held?.workedMs,
			gen: eventGen ?? ++pendingSeq,
		});
		updateStatus();
		// A `blocked` alert never waits behind a longer idle-poll deadline; a throttled queue keeps its retry time.
		scheduleFlush(DEBOUNCE_MS, !throttled && next === "blocked");
	}

	/** Applies one agent read: labels, sequence/focus metadata, transitions against what we last saw, pruning. */
	function sync(agents: AgentRow[]): void {
		const live = new Set<string>();
		for (const a of agents) {
			live.add(a.pane_id);
			recordRowFacts(a);
			observe(a.pane_id, a.agent_status, true);
		}
		for (const id of [...lastKnown.keys()]) {
			if (!live.has(id)) {
				lastKnown.delete(id);
				workingSince.delete(id);
				lastCompletionSeq.delete(id);
				lastStateSeq.delete(id);
				lastFocused.delete(id);
				lastEventSeq.delete(id);
				autoReviewed.delete(id);
			}
		}
		for (const id of [...paneWorkspace.keys()]) if (!live.has(id)) paneWorkspace.delete(id);
		let unblocked = false;
		for (const id of [...blockedPanes]) {
			if (live.has(id) && watchedSet.has(id)) continue;
			blockedPanes.delete(id);
			unblocked = true;
		}
		if (unblocked) showBlocked();
	}

	function capReached(now: number): boolean {
		wakeTimes = wakeTimes.filter(t => now - t < WAKE_WINDOW_MS);
		return wakeTimes.length >= WAKE_CAP;
	}

	/** Rate-cap hold: nothing is dropped; queued updates release together once the window clears. */
	function holdForCap(now: number): void {
		throttled = true;
		if (!capNotified) {
			capNotified = true;
			ctxRef?.ui.notify(
				`herdr-wake: ${WAKE_CAP} wakes within ${WAKE_WINDOW_MS / 60_000} min; holding queued updates until the window clears`,
				"warning",
			);
		}
		scheduleFlush(Math.max(DEBOUNCE_MS, wakeTimes[0]! + WAKE_WINDOW_MS - now + 50), true);
	}

	function sendBatch(panes: WakeRow[], delivery: Delivery): void {
		if (delivery !== "digest") {
			wakeTimes.push(Date.now());
			throttled = false;
			capNotified = false;
		}
		const content = prompt.render(wakeTemplate, { digest: delivery === "digest", panes, busyElsewhere: othersBusy() });
		const details = {
			delivery,
			panes: panes.map(({ pane, workspace, from, to, worked, focused }) => ({
				pane,
				workspace,
				from,
				to,
				...(worked ? { worked } : {}),
				...(focused ? { focused: true } : {}),
			})),
		};
		try {
			pi.logger.debug("herdr-wake: wake", details);
		} catch {
			// logging must never take the session down
		}
		try {
			Promise.resolve(
				pi.sendMessage(
					{ customType: WAKE_TYPE, content, display: true, attribution: "agent", details },
					DELIVERY_OPTIONS[delivery],
				),
			).catch(e => logWarn("sendMessage failed", { error: String(e) }));
		} catch (e) {
			logWarn("sendMessage threw", { error: String(e) });
		}
	}

	/**
	 * Settled (idle/done) entries wait for this session to be idle; `blocked` entries do not. Before
	 * anything spends a turn, queued entries are re-checked against live herdr state: a pane that is
	 * working again is dropped, one whose status moved is delivered with its current status.
	 */
	async function flushOnce(): Promise<void> {
		const wasIdle = ctxRef?.isIdle() === true;
		const hasBlocked = [...pending.values()].some(p => p.to === "blocked");
		if (!wasIdle && !hasBlocked) {
			// Only settled updates, and the manager is mid-turn: nothing can release, so skip the socket.
			throttled = false;
			scheduleFlush(IDLE_POLL_MS);
			return;
		}
		const needsActive = hasBlocked || [...pending.keys()].some(p => (explicitMode.get(p) ?? "wake") === "wake");
		let now = Date.now();
		if (wasIdle && needsActive) {
			const hold = userHoldMs(now);
			if (hold > 0) {
				throttled = false;
				scheduleFlush(hold);
				return;
			}
		}
		if (needsActive && capReached(now)) {
			holdForCap(now);
			return;
		}

		const snapshot = [...pending];
		let liveByPane: Map<string, AgentRow> | undefined;
		try {
			liveByPane = new Map((await listAgents()).map(a => [a.pane_id, a]));
		} catch (e) {
			logWarn("freshness listAgents failed, using cached state", { error: String(e) });
		}
		if (stopped) return;
		// The user may have submitted a prompt or started typing while the list was in flight.
		const nowIdle = ctxRef?.isIdle() === true;

		const asideBatch: WakeRow[] = [];
		const activeBatch: WakeRow[] = [];
		const digestBatch: WakeRow[] = [];
		for (const [pane, snap] of snapshot) {
			const cur = pending.get(pane);
			if (!cur) continue; // cancelled by a `working` event or `unwatch` while listing
			if (muted.has(pane) || !watchedSet.has(pane)) {
				pending.delete(pane);
				continue;
			}
			let to = cur.to;
			let liveRow: AgentRow | undefined;
			if (liveByPane) {
				// A newer event landed during the read; the list may predate it, so recheck next flush.
				if (cur.gen !== snap.gen) continue;
				liveRow = liveByPane.get(pane);
				if (!liveRow || liveRow.agent_status === "working") {
					pending.delete(pane);
					if (liveRow) {
						recordRowFacts(liveRow);
						lastKnown.set(pane, "working");
						autoReviewed.delete(pane);
					} else {
						lastKnown.delete(pane);
						autoReviewed.delete(pane);
					}
					continue;
				}
				recordRowFacts(liveRow);
				// herdr's transient `unknown` is not in KNOWN, so it keeps the queued state.
				if (liveRow.agent_status && KNOWN.has(liveRow.agent_status)) {
					to = liveRow.agent_status as Known;
					lastKnown.set(pane, to);
				}
			}
			if (!(explicit.get(pane) ?? DEFAULT_UNTIL).has(to)) {
				pending.delete(pane);
				continue;
			}
			if (to !== cur.to) pending.set(pane, { ...cur, to }); // not a new event: same gen
			const worked = cur.workedMs ? formatDuration(cur.workedMs) : undefined;
			const focused = (liveRow?.focused ?? lastFocused.get(pane)) === true;
			const metaParts: string[] = [];
			if (worked) metaParts.push(`worked ${worked}`);
			if (focused) metaParts.push("focused");
			const entry: WakeRow = {
				pane,
				label: labels.get(pane) ?? "agent",
				workspace: workspaceLabel(pane),
				from: cur.from,
				to,
				worked,
				focused: focused || undefined,
				meta: metaParts.length > 0 ? metaParts.join(", ") : undefined,
			};
			if (!nowIdle) {
				if (to === "blocked") asideBatch.push(entry); // settled entries stay queued until idle
			} else if (to === "blocked" || (explicitMode.get(pane) ?? "wake") === "wake") {
				activeBatch.push(entry);
			} else {
				digestBatch.push(entry);
			}
		}

		now = Date.now();
		if (asideBatch.length + activeBatch.length > 0) {
			if (nowIdle) {
				const hold = userHoldMs(now);
				if (hold > 0) {
					throttled = false;
					scheduleFlush(hold);
					return;
				}
			}
			if (capReached(now)) {
				holdForCap(now); // live state can promote a queued digest entry to `blocked`: recheck the cap
				return;
			}
		}
		for (const batch of [asideBatch, activeBatch, digestBatch]) for (const entry of batch) pending.delete(entry.pane);
		if (asideBatch.length > 0) {
			for (const entry of asideBatch) markReviewed(entry.pane, entry.to, liveByPane?.get(entry.pane));
			sendBatch(asideBatch, "aside");
		}
		if (activeBatch.length > 0) {
			// A turn is about to start anyway: one combined message beats two adjacent ones.
			activeBatch.push(...digestBatch);
			for (const entry of activeBatch) markReviewed(entry.pane, entry.to, liveByPane?.get(entry.pane));
			sendBatch(activeBatch, "wake");
		} else if (digestBatch.length > 0) {
			sendBatch(digestBatch, "digest");
		}
	}

	async function flush(): Promise<void> {
		if (stopped || pending.size === 0) {
			throttled = false;
			updateStatus();
			return;
		}
		if (flushing) {
			flushAgain = true;
			return;
		}
		flushing = true;
		flushAgain = false;
		try {
			await flushOnce();
		} catch (e) {
			logWarn("flush failed", { error: String(e) });
		} finally {
			flushing = false;
			if (pending.size === 0) throttled = false;
			updateStatus();
			if (!stopped && pending.size > 0 && flushTimer === undefined) {
				scheduleFlush(flushAgain ? DEBOUNCE_MS : IDLE_POLL_MS);
			}
		}
	}

	function onEvent(name: string, data: unknown): void {
		if (stopped) return;
		const kind = name.replace("_", ".");
		if (kind === "pane.agent_status_changed" && isRecord(data)) {
			const pane = str(data.pane_id);
			if (pane) {
				const agent = safeLabel(data.agent);
				if (agent) labels.set(pane, agent);
				const workspace = str(data.workspace_id);
				if (workspace) paneWorkspace.set(pane, workspace);
				observe(pane, str(data.agent_status), false);
				return;
			}
		}
		scheduleRefresh(); // lifecycle: the pane set changed
	}

	function onConnClosed(gen: number, reason: string): void {
		if (gen !== connGen || stopped) return; // a superseded subscription closing is expected
		conn = undefined;
		subscribedKey = "";
		logWarn("subscription lost", { reason });
		scheduleRetry();
	}

	async function resubscribe(want: string[], key: string): Promise<void> {
		const gen = ++connGen;
		const subs = [
			...LIFECYCLE.map(type => ({ type })),
			...want.map(pane_id => ({ type: "pane.agent_status_changed", pane_id })),
		];
		const next = await subscribe(
			subs,
			guarded(onEvent),
			guarded((reason: string) => onConnClosed(gen, reason)),
		);
		if (stopped || gen !== connGen) {
			next.close(); // superseded or shut down while the ack was in flight
			return;
		}
		const old = conn;
		conn = next;
		subscribedKey = key;
		old?.close();
		updateStatus();
	}

	/**
	 * List, subscribe, list again. The first read seeds the baseline and the watch set
	 * *before* subscribing (events can arrive in the same chunk as the ack, ahead of the
	 * code awaiting it); the second read, taken once the subscription is live, catches
	 * any transition that happened in the gap.
	 */
	async function refreshOnce(): Promise<void> {
		let agents = await readClusterState();
		for (let i = 0; i < 3 && !stopped; i++) {
			const want = desired(agents);
			const key = want.join(",");
			watchedSet = new Set(want);
			sync(agents);
			if (conn && key === subscribedKey) return;
			await resubscribe(want, key);
			agents = await readClusterState();
			sync(agents);
			if (desired(agents).join(",") === subscribedKey) return;
		}
	}

	async function refresh(): Promise<void> {
		if (stopped) return;
		if (refreshing) {
			dirty = true;
			return;
		}
		refreshing = true;
		try {
			do {
				dirty = false;
				await refreshOnce();
			} while (dirty && !stopped);
			backoffMs = BACKOFF_BASE_MS;
		} catch (e) {
			logWarn("refresh failed", { error: String(e) });
			scheduleRetry();
		} finally {
			refreshing = false;
		}
	}

	function scheduleRefresh(): void {
		if (stopped || refreshTimer !== undefined) return;
		refreshTimer = setTimer(() => {
			refreshTimer = undefined;
			void refresh();
		}, REFRESH_DEBOUNCE_MS);
	}

	function scheduleRetry(): void {
		if (stopped || retryTimer !== undefined) return;
		const delay = backoffMs;
		backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
		retryTimer = setTimer(() => {
			retryTimer = undefined;
			void refresh();
		}, delay);
	}

	function stop(): void {
		stopped = true;
		running = false;
		blockedPanes.clear();
		showBlocked();
		clearTimer(flushTimer);
		clearTimer(refreshTimer);
		clearTimer(retryTimer);
		flushTimer = refreshTimer = retryTimer = undefined;
		flushDueAt = 0;
		abortHoldUntil = 0;
		throttled = false;
		flushing = false;
		flushAgain = false;
		inlineCalls = 0;
		delegatedThisTurn = false;
		nudgedThisTurn = false;
		clearTimer(autoTimer);
		autoTimer = undefined;
		autoDueAt = 0;
		autoMs = 0;
		autoGen++;
		autoReviewed.clear();
		workingSince.clear();
		connGen++;
		conn?.close();
		conn = undefined;
		subscribedKey = "";
		watchedSet = new Set();
		pending.clear();
		updateStatus();
	}

	/** Live agent panes (other than this one) and how herdr-wake treats each; rendered by status.md. */
	async function readSnapshot(): Promise<{ snap: HerdrSnapshot; rows: AgentRow[]; seqBefore: number }> {
		const seqBefore = pendingSeq;
		const rows = (await listAgents()).filter(a => a.pane_id !== selfPane);
		const panes = rows.map((a): PaneStatus => {
			if ((lastEventSeq.get(a.pane_id) ?? 0) <= seqBefore) recordRowFacts(a);
			let watch = "not watched";
			if (muted.has(a.pane_id)) {
				watch = "muted";
			} else if (watchedSet.has(a.pane_id)) {
				watch = [...(explicit.get(a.pane_id) ?? DEFAULT_UNTIL)].join("|");
				if ((explicitMode.get(a.pane_id) ?? "wake") === "digest") watch += " (digest)";
			} else if (a.tokens?.[MANAGER_TOKEN] === "manager") {
				watch = "manager (not watched)";
			}
			const held = pending.get(a.pane_id);
			return {
				pane: a.pane_id,
				label: labels.get(a.pane_id) ?? a.label ?? "agent",
				workspace:
					a.workspace_id && a.workspace_id !== workspaceId
						? (workspaces.get(a.workspace_id)?.label ?? safeLabel(a.workspace_id, 48))
						: undefined,
				status: safeLabel(a.agent_status) ?? "unknown",
				focused: a.focused === true || undefined,
				watch,
				queued: held ? `${held.from} -> ${held.to}` : undefined,
			};
		});
		return {
			snap: { agents: panes.length, watched: watchedSet.size, queued: pending.size, throttled, panes },
			rows,
			seqBefore,
		};
	}

	function describeAuto(): string | undefined {
		if (autoMs === 0) return undefined;
		return `every ${formatDuration(autoMs)}, next in ${formatDuration(Math.max(autoDueAt - Date.now(), 0))}`;
	}

	/** (Re)arms the one auto-check timer a full interval out; with auto-check off it only clears it. */
	function scheduleAuto(): void {
		clearTimer(autoTimer);
		autoTimer = undefined;
		if (stopped || autoMs === 0) {
			autoDueAt = 0;
			return;
		}
		autoDueAt = Date.now() + autoMs;
		autoTimer = setTimer(() => {
			autoTimer = undefined;
			void autoCheck();
		}, autoMs);
	}

	/**
	 * `/herdr auto` tick: submit a scheduled review to the model. A tick that lands while this session is
	 * busy or yielding to the user is dropped, not delayed: the next one reads live state again. Otherwise
	 * it reviews only watched panes with unreviewed completed (`completion_seq`) or `blocked` transitions,
	 * skipping `done -> idle` sight flips, pane closures, `-> working` transitions, and transitions already
	 * delivered by an event wake. It shares the wake rate cap; at the cap the tick is skipped.
	 */
	async function autoCheck(): Promise<void> {
		if (stopped || autoMs === 0) return;
		scheduleAuto(); // the next tick is a full interval away whatever this one does
		if (ctxRef?.isIdle() !== true || userHoldMs(Date.now()) > 0) return;
		const gen = autoGen;
		try {
			const { snap, rows, seqBefore } = await readSnapshot();
			// Switched off or re-armed while the list was in flight, or the user/session became busy meanwhile: drop it.
			if (stopped || gen !== autoGen || ctxRef?.isIdle() !== true || userHoldMs(Date.now()) > 0) return;
			const liveIds = new Set<string>();
			const changed: AgentRow[] = [];
			for (const row of rows) {
				liveIds.add(row.pane_id);
				// A live event landed on this pane while the list was in flight: keep its live state and queued wake intact.
				if ((lastEventSeq.get(row.pane_id) ?? 0) > seqBefore) continue;
				if (row.agent_status === "working") {
					autoReviewed.delete(row.pane_id);
					continue;
				}
				if (!watchedSet.has(row.pane_id) || muted.has(row.pane_id)) continue;
				const norm = normReviewState(row.agent_status);
				if (!norm) continue;
				const allowed = explicit.get(row.pane_id) ?? DEFAULT_UNTIL;
				const allowedState = norm === "blocked" ? allowed.has("blocked") : allowed.has("idle") || allowed.has("done");
				if (!allowedState) continue;
				if (!isAlreadyReviewed(row) || pending.has(row.pane_id)) {
					changed.push(row);
				}
			}
			for (const id of [...autoReviewed.keys()]) {
				if (!liveIds.has(id) || !watchedSet.has(id) || muted.has(id)) autoReviewed.delete(id);
			}
			const now = Date.now();
			if (changed.length === 0 || capReached(now)) return;
			for (const row of changed) {
				if ((lastEventSeq.get(row.pane_id) ?? 0) > seqBefore) continue;
				markReviewed(row.pane_id, row.agent_status, row);
				const cur = pending.get(row.pane_id);
				if (cur && cur.gen <= seqBefore) pending.delete(row.pane_id);
			}
			if (pending.size === 0 && !throttled) {
				clearTimer(flushTimer);
				flushTimer = undefined;
				flushDueAt = 0;
			}
			updateStatus();
			wakeTimes.push(now);
			const changedPanes = changed.map(r => r.pane_id).join(", ");
			const content = prompt
				.render(checkTemplate, {
					scheduled: true,
					changedPanes,
					busyElsewhere: reviewBusy(snap),
					snapshot: prompt.render(statusTemplate, snap).trim(),
				})
				.trim();
			const details = {
				delivery: "check",
				changed: changed.map(r => r.pane_id),
				panes: snap.panes.map(({ pane, status }) => ({ pane, status })),
			};
			try {
				pi.logger.debug("herdr-wake: auto-check", details);
			} catch {
				// logging must never take the session down
			}
			Promise.resolve(
				pi.sendMessage(
					{ customType: WAKE_TYPE, content, display: true, attribution: "agent", details },
					DELIVERY_OPTIONS.wake,
				),
			).catch(e => logWarn("auto-check send failed", { error: String(e) }));
		} catch (e) {
			logWarn("auto-check failed", { error: String(e) });
		}
	}

	function setAuto(arg: string | undefined): { message: string; level: "info" | "warning" } {
		if (arg === "off") {
			const wasOn = autoMs > 0;
			autoMs = 0;
			autoGen++;
			autoReviewed.clear();
			scheduleAuto(); // off: clears the timer
			if (wasOn) persistState();
			updateStatus();
			return { message: `herdr-wake: auto-check ${wasOn ? "off" : "is already off"}`, level: "info" };
		}
		if (arg === undefined && autoMs > 0) return { message: `herdr-wake: auto-check ${describeAuto()}`, level: "info" };
		const ms = arg === undefined ? AUTO_DEFAULT_MS : parseInterval(arg);
		if (ms === undefined || ms < AUTO_MIN_MS || ms > AUTO_MAX_MS) {
			return { message: "herdr-wake: interval must be 1m-24h, e.g. 90s, 10m or 2h (or `off`)", level: "warning" };
		}
		const changed = autoMs !== ms;
		autoMs = ms;
		autoGen++;
		autoReviewed.clear(); // the first tick reviews whatever is open
		scheduleAuto();
		if (changed) persistState();
		updateStatus();
		return {
			message: `herdr-wake: auto-check every ${formatDuration(ms)}; a tick that lands while this session is busy is skipped`,
			level: "info",
		};
	}

	/** The review prompt asks for `ask` only when no watched pane is still working and nothing is queued. */
	function reviewBusy(snap: HerdrSnapshot): boolean {
		return snap.queued > 0 || snap.panes.some(p => p.status === "working" && watchedSet.has(p.pane));
	}

	function mutePaneId(paneId: string): void {
		explicit.delete(paneId);
		explicitMode.delete(paneId);
		pending.delete(paneId);
		blockedPanes.delete(paneId);
		autoReviewed.delete(paneId);
		muted.add(paneId);
		if (watchedSet.has(paneId)) {
			const next = new Set(watchedSet);
			next.delete(paneId);
			watchedSet = next;
		}
		persistState();
		showBlocked();
		updateStatus();
		scheduleRefresh();
	}

	/** `/herdr mute <pane>` and `/herdr unmute <pane>`. */
	async function setMutedCommand(target: string, mute: boolean, ctx: ExtensionContext): Promise<void> {
		try {
			const matches = await resolveTarget(target);
			if (matches.length === 0) {
				if (!mute && muted.delete(target)) {
					persistState();
					updateStatus();
					scheduleRefresh();
					ctx.ui.notify(`herdr-wake: unmuted ${target}`, "info");
					return;
				}
				ctx.ui.notify(`herdr-wake: no live agent pane matches ${target}.`, "warning");
				return;
			}
			if (matches.length > 1) {
				ctx.ui.notify(
					`herdr-wake: ${target} is ambiguous (${matches.map(m => m.pane_id).join(", ")}); use a pane id.`,
					"warning",
				);
				return;
			}
			const row = matches[0]!;
			if (row.pane_id === selfPane) {
				ctx.ui.notify(`herdr-wake: refusing to ${mute ? "mute" : "unmute"} this session's own pane.`, "warning");
				return;
			}
			const who = `${row.pane_id} (${row.label ?? "agent"})`;
			if (mute) {
				mutePaneId(row.pane_id);
				ctx.ui.notify(`herdr-wake: muted ${who}`, "info");
				return;
			}
			if (!muted.delete(row.pane_id)) {
				ctx.ui.notify(`herdr-wake: ${who} is not muted`, "info");
				return;
			}
			if (!watchedSet.has(row.pane_id) && row.tokens?.[MANAGER_TOKEN] !== "manager" && inScope(row.workspace_id)) {
				watchedSet = new Set([...watchedSet, row.pane_id].sort());
			}
			persistState();
			updateStatus();
			scheduleRefresh();
			ctx.ui.notify(`herdr-wake: unmuted ${who}`, "info");
		} catch (e) {
			ctx.ui.notify(
				`herdr-wake: could not ${mute ? "mute" : "unmute"} ${target}: ${e instanceof Error ? e.message : String(e)}`,
				"error",
			);
		}
	}

	/** `/herdr focus [pane]`: jump to a pane (default: the oldest blocked one) so the user can answer it there. */
	async function focusPane(target: string | undefined, ctx: ExtensionContext): Promise<void> {
		const want = target ?? [...blockedPanes][0];
		if (!want) {
			ctx.ui.notify("herdr-wake: no blocked pane to jump to. Usage: /herdr focus <pane>", "info");
			return;
		}
		try {
			const matches = await resolveTarget(want);
			if (matches.length !== 1) {
				const problem =
					matches.length === 0
						? `no live agent pane matches ${want}`
						: `${want} is ambiguous (${matches.map(m => m.pane_id).join(", ")}); use a pane id`;
				ctx.ui.notify(`herdr-wake: ${problem}.`, "warning");
				return;
			}
			await request("agent.focus", { target: matches[0]!.pane_id });
			ctx.ui.notify(`herdr-wake: focused ${matches[0]!.pane_id}`, "info");
		} catch (e) {
			ctx.ui.notify(`herdr-wake: could not focus ${want}: ${e instanceof Error ? e.message : String(e)}`, "error");
		}
	}

	function registerHerdrCommand(): void {
		const subcommands = [
			{ value: "status", label: "status", description: "List open agent panes and how they are watched" },
			{ value: "check", label: "check", description: "Ask the model to review every open agent pane" },
			{ value: "auto", label: "auto", description: "Review open agent panes on a cadence: auto [10m|off]" },
			{ value: "focus", label: "focus", description: "Jump to a blocked pane: focus [<pane>]" },
			{ value: "mute", label: "mute", description: "Stop watching a pane: mute <pane>" },
			{ value: "unmute", label: "unmute", description: "Resume watching a muted pane: unmute <pane>" },
		];
		pi.registerCommand("herdr", {
			description:
				"List open herdr agent panes; `check` asks the model to review them, `auto` repeats on a cadence, `mute`/`unmute` silences panes",
			getArgumentCompletions: prefix => {
				const space = prefix.indexOf(" ");
				if (space === -1) return subcommands.filter(s => s.value.startsWith(prefix.trim().toLowerCase()));
				const rawSub = prefix.slice(0, space);
				const sub = rawSub.toLowerCase();
				const argPrefix = prefix.slice(space + 1).trim();
				if (sub === "auto") {
					const presets = ["off", "2m", "5m", "10m", "30m"].filter(p => p.startsWith(argPrefix.toLowerCase()));
					return presets.length ? presets.map(p => ({ value: `${rawSub} ${p}`, label: p })) : null;
				}
				let candidates: string[] = [];
				if (sub === "focus") {
					candidates = [...new Set([...blockedPanes, ...lastKnown.keys()])];
				} else if (sub === "mute") {
					candidates = [...lastKnown.keys()].filter(p => !muted.has(p));
				} else if (sub === "unmute") {
					candidates = [...muted];
				} else {
					return null;
				}
				const hits = candidates
					.filter(p => p.toLowerCase().startsWith(argPrefix.toLowerCase()))
					.map(p => ({ value: `${rawSub} ${p}`, label: p, description: labels.get(p) }));
				return hits.length ? hits : null;
			},
			handler: async (args, ctx) => {
				if (!running) {
					ctx.ui.notify("herdr-wake is not running in this session (start omp inside herdr with --herdr-wake).", "warning");
					return;
				}
				// Only the subcommand and the interval are case-insensitive: pane ids are not (`w2X:p1`).
				const [first = "status", rest, ...extra] = args.trim().split(/\s+/).filter(Boolean);
				const sub = first.toLowerCase();
				const arg = sub === "auto" ? rest?.toLowerCase() : rest;
				const valid =
					extra.length === 0 &&
					((sub === "status" && arg === undefined) ||
						(sub === "check" && arg === undefined) ||
						sub === "auto" ||
						sub === "focus" ||
						((sub === "mute" || sub === "unmute") && arg !== undefined));
				if (!valid) {
					ctx.ui.notify(
						"Usage: /herdr [status|check|auto [<interval>|off]|focus [<pane>]|mute <pane>|unmute <pane>]",
						"warning",
					);
					return;
				}
				if (sub === "auto") {
					const { message, level } = setAuto(arg);
					ctx.ui.notify(message, level);
					return;
				}
				if (sub === "focus") {
					await focusPane(arg, ctx);
					return;
				}
				if (sub === "mute" || sub === "unmute") {
					await setMutedCommand(arg!, sub === "mute", ctx);
					return;
				}
				let snap: HerdrSnapshot;
				let rows: AgentRow[];
				let seqBefore: number;
				try {
					({ snap, rows, seqBefore } = await readSnapshot());
				} catch (e) {
					ctx.ui.notify(`herdr-wake: could not read the agent list: ${e instanceof Error ? e.message : String(e)}`, "error");
					return;
				}
				if (sub === "check") {
					for (const row of rows) {
						if (
							(lastEventSeq.get(row.pane_id) ?? 0) <= seqBefore &&
							watchedSet.has(row.pane_id) &&
							!muted.has(row.pane_id) &&
							row.agent_status !== "working"
						) {
							markReviewed(row.pane_id, row.agent_status, row);
						}
					}
					const status = prompt.render(statusTemplate, snap).trim();
					pi.sendUserMessage(prompt.render(checkTemplate, { snapshot: status, busyElsewhere: reviewBusy(snap) }).trim());
				} else {
					ctx.ui.notify(prompt.render(statusTemplate, { ...snap, auto: describeAuto() }).trim(), "info");
				}
			},
		});
	}

	/** Pane id, live agent name, or an agent kind when exactly one pane runs it. */
	async function resolveTarget(target: string): Promise<AgentRow[]> {
		const agents = await listAgents();
		const exact = agents.filter(a => a.pane_id === target || a.name === target);
		return exact.length > 0 ? exact : agents.filter(a => a.agent === target);
	}

	function registerWatchTool(): void {
		pi.registerTool({
			name: "herdr_watch",
			label: "Herdr Watch",
			description:
				"Choose which herdr agent panes wake this session. By default every other agent pane in this workspace, " +
				"or in another workspace of its worktree group (the primary workspace or a linked-worktree workspace), wakes it when it finishes (idle/done) or blocks. " +
				"`watch` adds any pane with optional `until` states; `unwatch` mutes one; `list` shows what is watched. " +
				"Wakes carry status only, never pane text.",
			approval: "read",
			loadMode: "essential",
			parameters: z.object({
				action: z.enum(["watch", "unwatch", "list"]),
				pane: z.string().optional().describe("Pane id (w1:p2), live agent name, or an agent kind when only one pane runs it; required for watch/unwatch"),
				until: z
					.array(z.enum(["idle", "done", "blocked"]))
					.optional()
					.describe("States that wake for this pane (default idle, done, blocked)"),
				mode: z
					.enum(["wake", "digest"])
					.optional()
					.describe(
						'How idle/done updates are delivered: "wake" (default) holds while busy and starts one batched turn when idle; "digest" queues for the next turn without starting one. blocked always alerts.',
					),
			}),
			async execute(
				_id: string,
				params: {
					action: "watch" | "unwatch" | "list";
					pane?: string;
					until?: Array<"idle" | "done" | "blocked">;
					mode?: WatchMode;
				},
			) {
				const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
				if (!running) return text("herdr-wake is not running in this session.");
				if (params.action === "list") {
					const rows = [...watchedSet].map(
						p =>
							`${p} (${labels.get(p) ?? "agent"}) -> ${[...(explicit.get(p) ?? DEFAULT_UNTIL)].join("|")}${(explicitMode.get(p) ?? "wake") === "digest" ? " [digest]" : ""}`,
					);
					for (const p of [...muted].sort()) {
						rows.push(`${p} (${labels.get(p) ?? "agent"}) -> muted`);
					}
					return text(rows.length ? rows.join("\n") : "No panes watched.");
				}
				if (!params.pane) return text(`\`pane\` is required for ${params.action}.`);
				const matches = await resolveTarget(params.pane);
				if (matches.length === 0) {
					if (params.action === "watch" && muted.delete(params.pane)) {
						persistState();
						updateStatus();
						scheduleRefresh();
						return text(`Unmuted ${params.pane}.`);
					}
					return text(`No live agent pane matches \`${params.pane}\`.`);
				}
				if (matches.length > 1) {
					return text(`\`${params.pane}\` is ambiguous (${matches.map(m => m.pane_id).join(", ")}); use a pane id.`);
				}
				const row = matches[0]!;
				if (row.pane_id === selfPane) return text("Refusing to watch this session's own pane.");
				if (params.action === "unwatch") {
					mutePaneId(row.pane_id);
					return text(`Muted ${row.pane_id}.`);
				}
				const until = params.until?.length ? new Set<string>(params.until) : DEFAULT_UNTIL;
				const mode: WatchMode = params.mode ?? "wake";
				muted.delete(row.pane_id);
				explicit.set(row.pane_id, until);
				if (mode === "digest") explicitMode.set(row.pane_id, "digest");
				else explicitMode.delete(row.pane_id);
				if (row.label) labels.set(row.pane_id, row.label);
				if (!watchedSet.has(row.pane_id)) {
					watchedSet = new Set([...watchedSet, row.pane_id].sort());
				}
				persistState();
				updateStatus();
				scheduleRefresh();
				return text(`Watching ${row.pane_id} until ${[...until].join("|")}${mode === "digest" ? " (digest)" : ""}.`);
			},
		});
	}

	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		// Flag values are applied after extensions load, so read it here, not in the factory.
		if (ctx.agent.kind !== "main" || pi.getFlag(FLAG) !== true) return;
		ctxRef = ctx;
		if (!insideHerdr) {
			ctx.ui.notify("herdr-wake: not inside a herdr pane (or nested omp); inactive.", "warning");
			return;
		}
		if (running) {
			restoreState(ctx);
			scheduleRefresh();
			return;
		}
		running = true;
		stopped = false;
		backoffMs = BACKOFF_BASE_MS;
		registerWatchTool();
		restoreState(ctx);
		if (selfPane) {
			request("pane.report_metadata", {
				pane_id: selfPane,
				source: WAKE_TYPE,
				tokens: { [MANAGER_TOKEN]: "manager" },
			}).catch(e => logWarn("could not advertise manager role", { error: String(e) }));
		}
		void refresh();
	});

	const onSessionChange = (_event: unknown, ctx: ExtensionContext) => {
		if (!running || stopped || ctx.agent.kind !== "main") return;
		ctxRef = ctx;
		restoreState(ctx);
		scheduleRefresh();
	};
	pi.on("session_switch", onSessionChange);
	pi.on("session_tree", onSessionChange);
	pi.on("session_branch", onSessionChange);

	pi.on("input", (event: unknown, ctx: ExtensionContext) => {
		if (!running || stopped || ctx.agent.kind !== "main") return;
		if (!isRecord(event) || event.source !== "extension") abortHoldUntil = 0;
	});

	pi.on("agent_start", (_event: unknown, ctx: ExtensionContext) => {
		if (!running || stopped || ctx.agent.kind !== "main") return;
		ctxRef = ctx;
		abortHoldUntil = 0;
		inlineCalls = 0;
		delegatedThisTurn = false;
		nudgedThisTurn = false;
	});

	pi.on("tool_result", (event: unknown, ctx: ExtensionContext) => {
		try {
			if (!running || stopped || ctx.agent.kind !== "main" || !isRecord(event)) return undefined;
			const toolName = str(event.toolName);
			if (!toolName || ORCHESTRATION_TOOLS[toolName]) return undefined;
			const failed = event.isError === true;
			if (toolName === "task") {
				if (!failed) {
					delegatedThisTurn = true;
					inlineCalls = 0;
				}
				return undefined;
			}
			const input = isRecord(event.input) ? event.input : undefined;
			if (toolName === "write") {
				const p = str(input?.path) ?? "";
				if (
					p.startsWith("out://") ||
					p.startsWith("proc://") ||
					p.startsWith("agent://") ||
					p.startsWith("local://") ||
					p.startsWith("/tmp/")
				) {
					return undefined;
				}
			} else if (toolName === "bash") {
				const cmd = str(input?.command) ?? "";
				if (HERDR_DISPATCH_RE.test(cmd)) {
					const hasJsonError =
						Array.isArray(event.content) &&
						event.content.some(c => isRecord(c) && typeof c.text === "string" && c.text.includes('"error":'));
					if (!failed && !hasJsonError) {
						delegatedThisTurn = true;
						inlineCalls = 0;
					}
					return undefined;
				}
				if (HERDR_CMD_RE.test(cmd)) return undefined;
			}
			inlineCalls++;
			if (!delegatedThisTurn && !nudgedThisTurn && inlineCalls >= INLINE_WORK_NUDGE_AT) {
				nudgedThisTurn = true;
				return { additionalContext: INLINE_DRIFT_NUDGE };
			}
		} catch {
			// never fail a tool result from a nudge check
		}
		return undefined;
	});

	pi.on("agent_end", (event: unknown, ctx: ExtensionContext) => {
		if (!running || stopped || ctx.agent.kind !== "main") return;
		ctxRef = ctx;
		if (wasTurnAborted(event)) {
			abortHoldUntil = Date.now() + ABORT_COOLDOWN_MS;
			if (pending.size > 0 && !throttled) scheduleFlush(ABORT_COOLDOWN_MS);
			return;
		}
		if (isRecord(event) && (event.willContinue === true || event.awaitingAsyncWork === true)) return;
		// agent_end fires before the session decrements its in-flight count, so isIdle() can still be
		// false on this tick: give it a moment, then release whatever waited for the end of the turn.
		if (pending.size > 0 && !throttled) scheduleFlush(IDLE_SETTLE_MS, true);
	});

	pi.on("before_agent_start", (event: { systemPrompt: string[] }, ctx: ExtensionContext) => {
		if (!running || ctx.agent.kind !== "main" || event.systemPrompt.includes(WORKTREE_GUIDE)) return undefined;
		// Pure function of the event: policy preparation may be retried and must stay idempotent.
		return { systemPrompt: [...event.systemPrompt, WORKTREE_GUIDE] };
	});

	pi.on("session_shutdown", async () => {
		if (!running) return;
		stop();
		if (selfPane) {
			await request(
				"pane.report_metadata",
				{
					pane_id: selfPane,
					source: WAKE_TYPE,
					tokens: { [MANAGER_TOKEN]: null },
				},
				SHUTDOWN_TIMEOUT_MS,
			).catch(() => {});
		}
	});
}
