// herdr-wake: wake this omp session when watched herdr panes change agent state.
//
// Armed per process with `omp --herdr-wake`; inert otherwise (and outside herdr). Pure extension:
// it talks to herdr's socket directly and needs no omp or herdr changes. It only reads herdr state;
// herdr's own omp integration (which reports this session's state outward) is unaffected.
//
// Flow: herdr socket `events.subscribe` -> per-pane queue -> debounce -> `pi.sendMessage`.
// Settled (idle/done) updates wait in the queue while this session is mid-turn and go out as one
// batched wake once it is idle; `blocked` alerts are injected at the next step boundary (`aside`);
// panes watched with `mode: "digest"` ride along on the next turn instead of starting one. Queued
// entries are re-checked against live `agent.list` before they spend a turn, and the wake rate cap
// defers queued updates instead of dropping them.
// The wake text is status-only. Pane text is untrusted and is never injected; the model
// reads it itself (`herdr agent read`) and may delegate heavy inspection to `task`.
//
// Scope: other agent panes in this workspace and in the rest of its worktree group: the primary
// workspace and its linked-worktree workspaces, i.e. every workspace on the same repo. While armed
// it also adds a standing manager preference to the system prompt (manager.md): prefer a
// linked-worktree workspace per delegated task.
//
// `/herdr` lists the open agent panes and how they are watched (local, no model turn);
// `/herdr check` submits the same snapshot with a review prompt (check.md) to the model;
// `/herdr auto [interval|off]` repeats that review on a cadence; a tick that lands while this
// session is busy is dropped, never delayed.
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

const DEBOUNCE_MS = 750; // coalesce flapping panes into one wake
const IDLE_SETTLE_MS = 100; // wait for AgentSession.#endInFlight() after agent_end
const IDLE_POLL_MS = 1_000; // backup poll while settled wakes wait for manager idle
const REFRESH_DEBOUNCE_MS = 200; // coalesce pane lifecycle bursts into one resync
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15_000;
const WAKE_WINDOW_MS = 10 * 60_000; // circuit breaker: agent <-> agent ping-pong guard
const WAKE_CAP = 20;
const REQUEST_TIMEOUT_MS = 3_000;
const AUTO_DEFAULT_MS = 10 * 60_000; // `/herdr auto` without an interval
const AUTO_MIN_MS = 60_000; // every tick can cost a model turn
const AUTO_MAX_MS = 24 * 3_600_000;

// Lifecycle events that change which panes exist or which are agents. The server also
// names some of them with an underscore (`pane_created`), so names are normalized below.
const LIFECYCLE = ["pane.created", "pane.closed", "pane.exited", "pane.moved", "pane.agent_detected"];

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
	/** Bumped on every observed transition; tells a flush whether an event landed while it awaited. */
	gen: number;
}

interface WakeRow {
	pane: string;
	label: string;
	workspace: string | undefined;
	from: Known | "unknown";
	to: Known;
}

interface PaneStatus {
	pane: string;
	label: string;
	workspace: string | undefined;
	status: string;
	watch: string;
	queued: string | undefined;
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
function request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
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
	const timer = setTimeout(() => finish(new Error(`${method} timed out`)), REQUEST_TIMEOUT_MS);
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

	const lastKnown = new Map<string, Known>();
	const labels = new Map<string, string>();
	const explicit = new Map<string, ReadonlySet<string>>(); // pane id -> states that wake
	const muted = new Set<string>();
	const blockedPanes = new Set<string>(); // watched panes blocked right now, oldest first; drives the alert widget

	const explicitMode = new Map<string, WatchMode>(); // pane id -> "digest" (omitted = "wake")
	const pending = new Map<string, PendingWake>();
	let pendingSeq = 0;
	let flushDueAt = 0;
	let throttled = false;
	let flushing = false;
	let flushAgain = false;
	let autoMs = 0; // `/herdr auto` cadence; 0 = off
	let autoTimer: TimerHandle | undefined;
	let autoDueAt = 0; // next tick
	let autoGen = 0; // bumped on every on/off/shutdown: an in-flight tick from an older schedule must not dispatch
	let autoSeen: string | undefined; // pane states at the last review; unchanged states are not reviewed again
	let wakeTimes: number[] = [];
	let capNotified = false;

	let refreshing = false;
	let dirty = false;
	let backoffMs = BACKOFF_BASE_MS;
	let flushTimer: TimerHandle | undefined;
	let refreshTimer: TimerHandle | undefined;
	let retryTimer: TimerHandle | undefined;
	/** workspace id -> git/worktree facts from workspace.list */
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

	async function listAgents(): Promise<AgentRow[]> {
		const result = await request("agent.list");
		const raw = Array.isArray(result.agents) ? result.agents : [];
		const rows: AgentRow[] = [];
		for (const item of raw) {
			const row = toAgentRow(item);
			if (row) rows.push(row);
		}
		return rows;
	}

	/** Resolves this pane's workspace and the git/worktree facts of every workspace. */
	async function ensureScope(): Promise<void> {
		if (!workspaceId) {
			const pane = await request("pane.get", { pane_id: selfPane });
			const info = isRecord(pane.pane) ? pane.pane : pane;
			workspaceId = str(info.workspace_id);
			if (!workspaceId) logWarn("could not resolve this pane's workspace; only explicit watches apply");
		}
		const result = await request("workspace.list");
		const raw = Array.isArray(result.workspaces) ? result.workspaces : [];
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
			if (explicit.has(a.pane_id) || inScope(a.workspace_id)) {
				out.push(a.pane_id);
			}
		}
		return out.sort();
	}

	/**
	 * `fromSnapshot` first-sights are baseline only (never wake on arming); anything else
	 * is a live event. Wakes: working -> idle|done, or anything -> blocked.
	 */
	function observe(paneId: string, status: string | undefined, fromSnapshot: boolean): void {
		if (!status || paneId === selfPane || !KNOWN.has(status)) return; // `unknown` flickers between states
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
		if (fromSnapshot && prev === undefined) return;
		if (!watchedSet.has(paneId)) return;
		const until = explicit.get(paneId) ?? DEFAULT_UNTIL;
		const settled = next === "idle" || next === "done";
		const fire = until.has(next) && ((settled && prev === "working") || (next === "blocked" && prev !== "blocked"));
		if (!fire) return;
		const held = pending.get(paneId);
		pending.set(paneId, { from: held?.from ?? prev ?? "unknown", to: next, gen: ++pendingSeq });
		updateStatus();
		// A `blocked` alert never waits behind a longer idle-poll deadline; a throttled queue keeps its retry time.
		scheduleFlush(DEBOUNCE_MS, !throttled && next === "blocked");
	}

	/** Applies one agent.list read: labels, transitions against what we last saw, pruning. */
	function sync(agents: AgentRow[]): void {
		const live = new Set<string>();
		for (const a of agents) {
			live.add(a.pane_id);
			if (a.label) labels.set(a.pane_id, a.label);
			if (a.workspace_id) paneWorkspace.set(a.pane_id, a.workspace_id);
			observe(a.pane_id, a.agent_status, true);
		}
		for (const id of [...lastKnown.keys()]) if (!live.has(id)) lastKnown.delete(id);
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
		const details = { delivery, panes: panes.map(({ pane, workspace, from, to }) => ({ pane, workspace, from, to })) };
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
		// The user may have submitted a prompt while the list was in flight.
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
			if (liveByPane) {
				// A newer event landed during the read; the list may predate it, so recheck next flush.
				if (cur.gen !== snap.gen) continue;
				const live = liveByPane.get(pane);
				if (!live || live.agent_status === "working") {
					pending.delete(pane);
					if (live) lastKnown.set(pane, "working");
					else lastKnown.delete(pane);
					continue;
				}
				if (live.label) labels.set(pane, live.label);
				if (live.workspace_id) paneWorkspace.set(pane, live.workspace_id);
				// herdr's transient `unknown` is not in KNOWN, so it keeps the queued state.
				if (live.agent_status && KNOWN.has(live.agent_status)) {
					to = live.agent_status as Known;
					lastKnown.set(pane, to);
				}
			}
			if (!(explicit.get(pane) ?? DEFAULT_UNTIL).has(to)) {
				pending.delete(pane);
				continue;
			}
			if (to !== cur.to) pending.set(pane, { ...cur, to }); // not a new event: same gen
			const entry: WakeRow = {
				pane,
				label: labels.get(pane) ?? "agent",
				workspace: workspaceLabel(pane),
				from: cur.from,
				to,
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
		if (asideBatch.length + activeBatch.length > 0 && capReached(now)) {
			holdForCap(now); // live state can promote a queued digest entry to `blocked`: recheck the cap
			return;
		}
		for (const batch of [asideBatch, activeBatch, digestBatch]) for (const entry of batch) pending.delete(entry.pane);
		if (asideBatch.length > 0) sendBatch(asideBatch, "aside");
		if (activeBatch.length > 0) {
			// A turn is about to start anyway: one combined message beats two adjacent ones.
			activeBatch.push(...digestBatch);
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
		await ensureScope();
		let agents = await listAgents();
		for (let i = 0; i < 3 && !stopped; i++) {
			const want = desired(agents);
			const key = want.join(",");
			watchedSet = new Set(want);
			sync(agents);
			if (!conn || key !== subscribedKey) await resubscribe(want, key);
			agents = await listAgents();
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
		throttled = false;
		flushing = false;
		flushAgain = false;
		clearTimer(autoTimer);
		autoTimer = undefined;
		autoDueAt = 0;
		autoMs = 0;
		autoGen++;
		autoSeen = undefined;
		connGen++;
		conn?.close();
		conn = undefined;
		subscribedKey = "";
		watchedSet = new Set();
		pending.clear();
		updateStatus();
	}

	/** Live agent panes (other than this one) and how herdr-wake treats each; rendered by status.md. */
	async function snapshot(): Promise<HerdrSnapshot> {
		const rows = (await listAgents()).filter(a => a.pane_id !== selfPane);
		const panes = rows.map((a): PaneStatus => {
			let watch = "not watched";
			if (muted.has(a.pane_id)) {
				watch = "muted";
			} else if (watchedSet.has(a.pane_id)) {
				watch = [...(explicit.get(a.pane_id) ?? DEFAULT_UNTIL)].join("|");
				if ((explicitMode.get(a.pane_id) ?? "wake") === "digest") watch += " (digest)";
			}
			const held = pending.get(a.pane_id);
			return {
				pane: a.pane_id,
				label: a.label ?? "agent",
				workspace:
					a.workspace_id && a.workspace_id !== workspaceId
						? (workspaces.get(a.workspace_id)?.label ?? safeLabel(a.workspace_id, 48))
						: undefined,
				status: safeLabel(a.agent_status) ?? "unknown",
				watch,
				queued: held ? `${held.from} -> ${held.to}` : undefined,
			};
		});
		return { agents: panes.length, watched: watchedSet.size, queued: pending.size, throttled, panes };
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
	 * busy is dropped, not delayed: the next one reads live state again. Otherwise it reviews only when a
	 * pane needs a look (one that is not `working`, or has an update held in the queue) and the pane states
	 * differ from the last review. It spends a slot of the same wake budget as event wakes; at the cap the
	 * tick is skipped too.
	 */
	async function autoCheck(): Promise<void> {
		if (stopped || autoMs === 0) return;
		scheduleAuto(); // the next tick is a full interval away whatever this one does
		if (ctxRef?.isIdle() !== true) return;
		const gen = autoGen;
		try {
			const snap = await snapshot();
			// Switched off or re-armed while the list was in flight, or a turn started meanwhile: drop it.
			if (stopped || gen !== autoGen || ctxRef?.isIdle() !== true) return;
			const needsLook = snap.queued > 0 || snap.panes.some(p => p.status !== "working");
			const signature = snap.panes
				.map(p => `${p.pane}:${p.status}:${p.queued ?? ""}`)
				.sort()
				.join("|");
			if (!needsLook) {
				autoSeen = signature;
			} else if (signature !== autoSeen && !capReached(Date.now())) {
				autoSeen = signature;
				wakeTimes.push(Date.now());
				const content = prompt
					.render(checkTemplate, {
						scheduled: true,
						busyElsewhere: reviewBusy(snap),
						snapshot: prompt.render(statusTemplate, snap).trim(),
					})
					.trim();
				const details = { delivery: "check", panes: snap.panes.map(({ pane, status }) => ({ pane, status })) };
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
			}
		} catch (e) {
			logWarn("auto-check failed", { error: String(e) });
		}
	}

	function setAuto(arg: string | undefined): { message: string; level: "info" | "warning" } {
		if (arg === "off") {
			const wasOn = autoMs > 0;
			autoMs = 0;
			autoGen++;
			autoSeen = undefined;
			scheduleAuto(); // off: clears the timer
			updateStatus();
			return { message: `herdr-wake: auto-check ${wasOn ? "off" : "is already off"}`, level: "info" };
		}
		if (arg === undefined && autoMs > 0) return { message: `herdr-wake: auto-check ${describeAuto()}`, level: "info" };
		const ms = arg === undefined ? AUTO_DEFAULT_MS : parseInterval(arg);
		if (ms === undefined || ms < AUTO_MIN_MS || ms > AUTO_MAX_MS) {
			return { message: "herdr-wake: interval must be 1m-24h, e.g. 90s, 10m or 2h (or `off`)", level: "warning" };
		}
		autoMs = ms;
		autoGen++;
		autoSeen = undefined; // the first tick reviews whatever is open
		scheduleAuto();
		updateStatus();
		return {
			message: `herdr-wake: auto-check every ${formatDuration(ms)}; a tick that lands while this session is busy is skipped`,
			level: "info",
		};
	}

	/** The review prompt asks for `ask` only when no pane is still working and nothing is queued. */
	function reviewBusy(snap: HerdrSnapshot): boolean {
		return snap.queued > 0 || snap.panes.some(p => p.status === "working");
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
		];
		pi.registerCommand("herdr", {
			description: "List open herdr agent panes; `check` asks the model to review them, `auto` repeats that on a cadence",
			getArgumentCompletions: prefix => subcommands.filter(s => s.value.startsWith(prefix.trim().toLowerCase())),
			handler: async (args, ctx) => {
				if (!running) {
					ctx.ui.notify("herdr-wake is not running in this session (start omp inside herdr with --herdr-wake).", "warning");
					return;
				}
				// Only the subcommand and the interval are case-insensitive: pane ids are not (`w2X:p1`).
				const [first = "status", rest, ...extra] = args.trim().split(/\s+/).filter(Boolean);
				const sub = first.toLowerCase();
				const arg = sub === "auto" ? rest?.toLowerCase() : rest;
				if (extra.length > 0 || (sub !== "auto" && sub !== "focus" && arg !== undefined) || !subcommands.some(s => s.value === sub)) {
					ctx.ui.notify("Usage: /herdr [status|check|auto [<interval>|off]|focus [<pane>]]", "warning");
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
				let snap: HerdrSnapshot;
				try {
					snap = await snapshot();
				} catch (e) {
					ctx.ui.notify(`herdr-wake: could not read the agent list: ${e instanceof Error ? e.message : String(e)}`, "error");
					return;
				}
				if (sub === "check") {
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
					return text(rows.length ? rows.join("\n") : "No panes watched.");
				}
				if (!params.pane) return text(`\`pane\` is required for ${params.action}.`);
				const matches = await resolveTarget(params.pane);
				if (matches.length === 0) return text(`No live agent pane matches \`${params.pane}\`.`);
				if (matches.length > 1) {
					return text(`\`${params.pane}\` is ambiguous (${matches.map(m => m.pane_id).join(", ")}); use a pane id.`);
				}
				const row = matches[0]!;
				if (row.pane_id === selfPane) return text("Refusing to watch this session's own pane.");
				if (params.action === "unwatch") {
					explicit.delete(row.pane_id);
					explicitMode.delete(row.pane_id);
					pending.delete(row.pane_id);
					blockedPanes.delete(row.pane_id);
					showBlocked();
					muted.add(row.pane_id);
					updateStatus();
					scheduleRefresh();
					return text(`Muted ${row.pane_id}.`);
				}
				const until = params.until?.length ? new Set<string>(params.until) : DEFAULT_UNTIL;
				const mode: WatchMode = params.mode ?? "wake";
				muted.delete(row.pane_id);
				explicit.set(row.pane_id, until);
				if (mode === "digest") explicitMode.set(row.pane_id, "digest");
				else explicitMode.delete(row.pane_id);
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
			scheduleRefresh();
			return;
		}
		running = true;
		stopped = false;
		backoffMs = BACKOFF_BASE_MS;
		registerWatchTool();
		void refresh();
	});

	pi.on("agent_end", (_event: unknown, ctx: ExtensionContext) => {
		if (!running || stopped || ctx.agent.kind !== "main") return;
		ctxRef = ctx;
		// agent_end fires before the session decrements its in-flight count, so isIdle() can still be
		// false on this tick: give it a moment, then release whatever waited for the end of the turn.
		if (pending.size > 0 && !throttled) scheduleFlush(IDLE_SETTLE_MS, true);
	});

	pi.on("before_agent_start", (event: { systemPrompt: string[] }, ctx: ExtensionContext) => {
		if (!running || ctx.agent.kind !== "main" || event.systemPrompt.includes(WORKTREE_GUIDE)) return undefined;
		// Pure function of the event: policy preparation may be retried and must stay idempotent.
		return { systemPrompt: [...event.systemPrompt, WORKTREE_GUIDE] };
	});

	pi.on("session_shutdown", () => {
		if (running) stop();
	});
}
