// A fake herdr socket, a fake omp session and a fake clock around the real extension.
//
// Time is simulated: the harness owns the extension's timers (via ctx.setTimeout) and Date.now(),
// so a ten-minute rate-cap window costs milliseconds. Only the socket round trips are real.
import * as fs from "node:fs";
import net from "node:net";
import { setSystemTime } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import herdrWake from "../src/index";

export type PaneStatus = "working" | "idle" | "done" | "blocked" | "unknown";

export interface FakeWorkspace {
	workspace_id: string;
	label?: string;
	worktree?: { repo_key?: string };
}

export interface FakeAgent {
	pane_id: string;
	workspace_id: string;
	agent_status: PaneStatus;
	agent: string;
	name?: string;
	focused?: boolean;
	completion_seq?: number;
	state_change_seq?: number;
	tokens?: Record<string, string>;
}

export interface CustomEntry {
	type: "custom";
	customType: string;
	data: unknown;
}

export interface Sent {
	content: string;
	attribution: string;
	delivery: string;
	changed?: string[];
	panes: Array<{ pane: string; from?: string; to?: string; status?: string; worked?: string; focused?: boolean }>;
	options: { triggerTurn?: boolean; deliverAs?: string };
}

export interface Notice {
	message: string;
	level: string | undefined;
}

interface Timer {
	fn: () => void;
	due: number;
	cleared: boolean;
	fired: boolean;
}

type Handler = (event: unknown, ctx: unknown) => unknown;

const START = Date.UTC(2026, 0, 1);
const SETTLE_MS = 30; // real time for a localhost socket round trip to finish

export interface Harness {
	sent: Sent[];
	users: string[];
	notices: Notice[];
	status(): string | undefined;
	/** The alert widget above the editor, if one is set. */
	widget(): string[] | undefined;
	/** Live herdr state. With `event: true` herdr also pushes the status-changed event. */
	setLive(pane: string, status: PaneStatus, options?: { event?: boolean; focused?: boolean }): Promise<void>;
	upsertAgent(agent: FakeAgent, options?: { event?: string }): Promise<void>;
	removeAgent(pane: string, options?: { event?: boolean }): Promise<void>;
	setWorkspaces(workspaces: FakeWorkspace[], options?: { event?: string }): Promise<void>;
	setIdle(idle: boolean): void;
	setEditorText(text: string): void;
	setPlanReview(open: boolean): void;
	/** Delay `agent.list` replies until `releaseList()`, to land events mid-read. */
	holdList(): void;
	releaseList(): Promise<void>;
	listCalls(): number;
	advance(ms: number): Promise<void>;
	settle(): Promise<void>;
	/** `/herdr <args>` */
	command(args: string): Promise<void>;
	complete(prefix: string): Array<{ value: string; label: string; description?: string }> | null;
	/** `herdr_watch` tool; resolves to its text output. */
	tool(params: Record<string, unknown>): Promise<string>;
	input(text: string, source?: "interactive" | "rpc" | "extension"): Promise<void>;
	agentStart(): Promise<void>;
	agentEnd(event?: Record<string, unknown>): Promise<void>;
	switchSession(entries?: CustomEntry[]): Promise<void>;
	entries(): CustomEntry[];
	paneTokens(pane: string): Record<string, string> | undefined;
	/** Pending timers, with the delay of the soonest. */
	timers(): { count: number; nextInMs: number | undefined };
	shutdown(): Promise<void>;
	registered: { commands: Map<string, unknown>; flags: Map<string, unknown> };
	/** Every request the extension sent to the fake herdr, in order. */
	requests: Array<{ method: string; params: Record<string, unknown> }>;
}

export async function createHarness(
	options: {
		panes?: string[];
		statuses?: Record<string, PaneStatus>;
		agents?: FakeAgent[];
		workspaces?: FakeWorkspace[];
		branchEntries?: CustomEntry[];
		disableSnapshot?: boolean;
	} = {},
): Promise<Harness> {
	const socketPath = process.env.HERDR_SOCKET_PATH!;
	fs.rmSync(socketPath, { force: true });
	let now = START;
	setSystemTime(new Date(now));

	let seq = 0;
	let workspaces: FakeWorkspace[] = options.workspaces ?? [
		{ workspace_id: "w1", label: "wake", worktree: { repo_key: "repo-main" } },
	];
	const paneTokens = new Map<string, Record<string, string>>();
	const agents = new Map<string, FakeAgent>();
	if (options.agents) {
		for (const a of options.agents) {
			const s = ++seq;
			agents.set(a.pane_id, {
				state_change_seq: s,
				completion_seq: a.agent_status === "idle" || a.agent_status === "done" ? s : undefined,
				...a,
			});
		}
	} else {
		for (const pane of options.panes ?? ["w1:p2", "w1:p3"]) {
			const s = ++seq;
			agents.set(pane, {
				pane_id: pane,
				workspace_id: "w1",
				agent_status: "working",
				agent: `worker-${pane.split(":")[1]}`,
				state_change_seq: s,
			});
		}
	}
	for (const [pane, status] of Object.entries(options.statuses ?? {})) {
		const row = agents.get(pane)!;
		row.agent_status = status;
		row.state_change_seq = ++seq;
		if (status === "idle" || status === "done") row.completion_seq = row.state_change_seq;
	}

	const serializeAgents = () =>
		[...agents.values()].map(a => {
			const merged = { ...(a.tokens ?? {}), ...(paneTokens.get(a.pane_id) ?? {}) };
			return Object.keys(merged).length > 0 ? { ...a, tokens: merged } : a;
		});

	// ---- fake herdr
	const subscribers = new Set<net.Socket>();
	const heldReplies: Array<() => void> = [];
	let holding = false;
	let listCalls = 0;
	const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
	const server = net.createServer(socket => {
		let buf = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buf += chunk;
			for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
				const msg = JSON.parse(buf.slice(0, i)) as { id: string; method: string; params?: Record<string, unknown> };
				buf = buf.slice(i + 1);
				const params = msg.params ?? {};
				requests.push({ method: msg.method, params });
				const reply = (result: unknown) => socket.write(`${JSON.stringify({ id: msg.id, result })}\n`);
				const rejectReq = (code: string, message: string) =>
					socket.write(`${JSON.stringify({ id: msg.id, error: { code, message } })}\n`);
				if (msg.method === "agent.list") {
					listCalls++;
					const snapAgents = serializeAgents();
					const respond = () => reply({ agents: snapAgents });
					if (holding) heldReplies.push(respond);
					else respond();
				} else if (msg.method === "session.snapshot") {
					if (options.disableSnapshot) {
						rejectReq("unknown_method", "session.snapshot");
					} else {
						reply({
							type: "session_snapshot",
							snapshot: {
								version: "0.9.5",
								protocol: 1,
								workspaces,
								tabs: [],
								panes: [
									{ pane_id: process.env.HERDR_PANE_ID ?? "w1:p1", workspace_id: process.env.HERDR_WORKSPACE_ID ?? "w1" },
									...serializeAgents(),
								],
								layouts: [],
								agents: serializeAgents(),
							},
						});
					}
				} else if (msg.method === "workspace.list") {
					reply({ workspaces });
				} else if (msg.method === "pane.get") {
					reply({ pane: { pane_id: params.pane_id, workspace_id: "w1" } });
				} else if (msg.method === "pane.report_metadata") {
					const paneId = String(params.pane_id ?? "");
					const patch = (params.tokens ?? {}) as Record<string, string | null>;
					const cur = { ...(paneTokens.get(paneId) ?? {}) };
					for (const [k, v] of Object.entries(patch)) {
						if (v === null) delete cur[k];
						else if (typeof v === "string") cur[k] = v;
					}
					if (Object.keys(cur).length > 0) paneTokens.set(paneId, cur);
					else paneTokens.delete(paneId);
					reply({ type: "ok" });
				} else if (msg.method === "events.subscribe") {
					subscribers.add(socket);
					socket.on("close", () => subscribers.delete(socket));
					reply({ type: "subscription_started" });
				} else if (msg.method === "agent.focus") {
					reply({ type: "ok" });
				} else {
					rejectReq("unknown_method", msg.method);
				}
			}
		});
		socket.on("error", () => {});
	});
	{
		const { promise, resolve } = Promise.withResolvers<void>();
		server.listen(socketPath, resolve);
		await promise;
	}

	// ---- fake omp
	const chain: unknown = new Proxy(() => {}, { get: () => chain, apply: () => chain });
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<
		string,
		{
			handler: (args: string, ctx: unknown) => Promise<void>;
			getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string; description?: string }> | null;
		}
	>();
	const flags = new Map<string, unknown>();
	let tool: { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> } | undefined;
	const sent: Sent[] = [];
	const users: string[] = [];
	const notices: Notice[] = [];
	let branchEntries: CustomEntry[] = [...(options.branchEntries ?? [])];
	let statusText: string | undefined;
	let widgetLines: string[] | undefined;
	let editorText = "";
	let planReviewOpen = false;
	let idle = true;
	const timers: Timer[] = [];

	const pi = {
		registerFlag: (name: string, def: unknown) => flags.set(name, def),
		zod: chain,
		getFlag: () => true,
		registerTool: (def: never) => {
			tool = def;
		},
		registerCommand: (name: string, def: never) => commands.set(name, def),
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		logger: { debug() {}, warn() {} },
		appendEntry(customType: string, data: unknown) {
			branchEntries.push({ type: "custom", customType, data });
		},
		sendMessage(
			message: { content: string; attribution: string; details: Pick<Sent, "delivery" | "panes" | "changed"> },
			options: Sent["options"] = {},
		) {
			sent.push({ content: message.content, attribution: message.attribution, ...message.details, options });
		},
		sendUserMessage: (text: string) => users.push(text),
	};
	const ctx = {
		agent: { kind: "main" },
		isIdle: () => idle,
		getPendingPlanReview: () => (planReviewOpen ? { reviewId: "rev-1" } : undefined),
		sessionManager: {
			getBranch: () => [...branchEntries],
		},
		ui: {
			setStatus: (_key: string, text?: string) => {
				statusText = text;
			},
			notify: (message: string, level?: string) => notices.push({ message, level }),
			setWidget: (_key: string, content?: string[]) => {
				widgetLines = content;
			},
			getEditorText: () => editorText,
		},
		setTimeout(fn: () => void, ms: number): Timer {
			const timer: Timer = { fn, due: now + ms, cleared: false, fired: false };
			timers.push(timer);
			return timer;
		},
		clearTimer(timer: Timer) {
			timer.cleared = true;
		},
	};

	const settle = () => Bun.sleep(SETTLE_MS);
	const live = () => timers.filter(t => !t.cleared && !t.fired);
	const emit = (event: string, data: unknown) => {
		for (const socket of subscribers) if (!socket.destroyed) socket.write(`${JSON.stringify({ event, data })}\n`);
	};

	herdrWake(pi as unknown as ExtensionAPI);
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx as unknown as ExtensionContext);
	await settle();
	await settle();

	return {
		sent,
		users,
		notices,
		registered: { commands, flags },
		requests,
		widget: () => widgetLines,
		status: () => statusText,
		async setLive(pane, status, { event = false, focused } = {}) {
			const row = agents.get(pane)!;
			const prev = row.agent_status;
			row.agent_status = status;
			if (focused !== undefined) row.focused = focused;
			if (prev !== status) {
				row.state_change_seq = ++seq;
				// Real herdr bumps completion_seq when completing work (working -> idle|done), not on done -> idle sight flips.
				if ((status === "idle" || status === "done") && prev === "working") {
					row.completion_seq = row.state_change_seq;
				}
			}
			if (!event) return;
			emit("pane_agent_status_changed", {
				pane_id: pane,
				agent_status: status,
				workspace_id: row.workspace_id,
				agent: row.agent,
			});
			await settle();
		},
		async upsertAgent(agent, { event } = {}) {
			const s = ++seq;
			agents.set(agent.pane_id, {
				state_change_seq: s,
				completion_seq: agent.agent_status === "idle" || agent.agent_status === "done" ? s : undefined,
				...agent,
			});
			if (event) {
				emit(event, { pane_id: agent.pane_id, workspace_id: agent.workspace_id });
				await settle();
			}
		},
		async removeAgent(pane, { event = false } = {}) {
			const row = agents.get(pane);
			agents.delete(pane);
			if (event && row) {
				emit("pane_closed", { pane_id: pane, workspace_id: row.workspace_id });
				await settle();
			}
		},
		async setWorkspaces(next, { event } = {}) {
			workspaces = next;
			if (event) {
				emit(event, {});
				await settle();
			}
		},
		setIdle(value) {
			idle = value;
		},
		setEditorText(text) {
			editorText = text;
		},
		setPlanReview(open) {
			planReviewOpen = open;
		},
		holdList() {
			holding = true;
		},
		async releaseList() {
			holding = false;
			for (const respond of heldReplies.splice(0)) respond();
			await settle();
		},
		listCalls: () => listCalls,
		async advance(ms) {
			const target = now + ms;
			for (;;) {
				const due = live()
					.filter(t => t.due <= target)
					.sort((a, b) => a.due - b.due)[0];
				if (!due) break;
				now = Math.max(now, due.due); // each timer sees the time it was due, not the end of the jump
				setSystemTime(new Date(now));
				due.fired = true;
				due.fn();
				await settle();
			}
			now = target;
			setSystemTime(new Date(now));
			await settle();
		},
		settle,
		async command(args) {
			notices.length = 0;
			await commands.get("herdr")!.handler(args, ctx);
		},
		complete(prefix) {
			return commands.get("herdr")!.getArgumentCompletions?.(prefix) ?? null;
		},
		async tool(params) {
			return (await tool!.execute("test", params)).content[0]!.text;
		},
		async input(text, source = "interactive") {
			for (const handler of handlers.get("input") ?? []) await handler({ type: "input", text, source }, ctx);
		},
		async agentStart() {
			for (const handler of handlers.get("agent_start") ?? []) await handler({ type: "agent_start" }, ctx);
		},
		async agentEnd(event = {}) {
			for (const handler of handlers.get("agent_end") ?? []) await handler(event, ctx);
		},
		async switchSession(entries = []) {
			branchEntries = [...entries];
			for (const handler of handlers.get("session_switch") ?? []) await handler({ type: "session_switch" }, ctx);
		},
		entries: () => [...branchEntries],
		paneTokens: pane => paneTokens.get(pane),
		timers() {
			const pending = live();
			return { count: pending.length, nextInMs: pending.length ? Math.min(...pending.map(t => t.due)) - now : undefined };
		},
		async shutdown() {
			for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
			for (const socket of subscribers) socket.destroy();
			const { promise, resolve } = Promise.withResolvers<void>();
			server.close(() => resolve());
			await promise;
			fs.rmSync(socketPath, { force: true });
			setSystemTime();
		},
	};
}
