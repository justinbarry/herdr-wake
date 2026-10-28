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

interface FakeAgent {
	pane_id: string;
	workspace_id: string;
	agent_status: PaneStatus;
	agent: string;
}

export interface Sent {
	content: string;
	attribution: string;
	delivery: string;
	panes: Array<{ pane: string; from: string; to: string }>;
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
	setLive(pane: string, status: PaneStatus, options?: { event?: boolean }): Promise<void>;
	setIdle(idle: boolean): void;
	/** Delay `agent.list` replies until `releaseList()`, to land events mid-read. */
	holdList(): void;
	releaseList(): Promise<void>;
	listCalls(): number;
	advance(ms: number): Promise<void>;
	settle(): Promise<void>;
	/** `/herdr <args>` */
	command(args: string): Promise<void>;
	/** `herdr_watch` tool; resolves to its text output. */
	tool(params: Record<string, unknown>): Promise<string>;
	agentEnd(): Promise<void>;
	/** Pending timers, with the delay of the soonest. */
	timers(): { count: number; nextInMs: number | undefined };
	shutdown(): Promise<void>;
	registered: { commands: Map<string, unknown>; flags: Map<string, unknown> };
	/** Every request the extension sent to the fake herdr, in order. */
	requests: Array<{ method: string; params: Record<string, unknown> }>;
}

export async function createHarness(
	options: { panes?: string[]; statuses?: Record<string, PaneStatus> } = {},
): Promise<Harness> {
	const socketPath = process.env.HERDR_SOCKET_PATH!;
	fs.rmSync(socketPath, { force: true });
	let now = START;
	setSystemTime(new Date(now));

	const agents = new Map<string, FakeAgent>();
	for (const pane of options.panes ?? ["w1:p2", "w1:p3"]) {
		agents.set(pane, { pane_id: pane, workspace_id: "w1", agent_status: "working", agent: `worker-${pane.split(":")[1]}` });
	}
	for (const [pane, status] of Object.entries(options.statuses ?? {})) agents.get(pane)!.agent_status = status;

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
				requests.push({ method: msg.method, params: msg.params ?? {} });
				const reply = (result: unknown) => socket.write(`${JSON.stringify({ id: msg.id, result })}\n`);
				if (msg.method === "agent.list") {
					listCalls++;
					const respond = () => reply({ agents: [...agents.values()] });
					if (holding) heldReplies.push(respond);
					else respond();
				} else if (msg.method === "workspace.list") {
					reply({ workspaces: [{ workspace_id: "w1", label: "wake" }] });
				} else if (msg.method === "events.subscribe") {
					subscribers.add(socket);
					socket.on("close", () => subscribers.delete(socket));
					reply({ type: "subscription_started" });
				} else if (msg.method === "agent.focus") {
					reply({ type: "ok" });
				}
			}
		});
		socket.on("error", () => {});
	});
	await new Promise<void>(resolve => server.listen(socketPath, resolve));

	// ---- fake omp
	const chain: unknown = new Proxy(() => {}, { get: () => chain, apply: () => chain });
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const flags = new Map<string, unknown>();
	let tool: { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> } | undefined;
	const sent: Sent[] = [];
	const users: string[] = [];
	const notices: Notice[] = [];
	let statusText: string | undefined;
	let widgetLines: string[] | undefined;
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
		sendMessage(
			message: { content: string; attribution: string; details: Pick<Sent, "delivery" | "panes"> },
			options: Sent["options"] = {},
		) {
			sent.push({ content: message.content, attribution: message.attribution, ...message.details, options });
		},
		sendUserMessage: (text: string) => users.push(text),
	};
	const ctx = {
		agent: { kind: "main" },
		isIdle: () => idle,
		ui: {
			setStatus: (_key: string, text?: string) => {
				statusText = text;
			},
			notify: (message: string, level?: string) => notices.push({ message, level }),
			setWidget: (_key: string, content?: string[]) => {
				widgetLines = content;
			},
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
		async setLive(pane, status, { event = false } = {}) {
			agents.get(pane)!.agent_status = status;
			if (!event) return;
			emit("pane_agent_status_changed", {
				pane_id: pane,
				agent_status: status,
				workspace_id: "w1",
				agent: agents.get(pane)!.agent,
			});
			await settle();
		},
		setIdle(value) {
			idle = value;
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
		async tool(params) {
			return (await tool!.execute("test", params)).content[0]!.text;
		},
		async agentEnd() {
			for (const handler of handlers.get("agent_end") ?? []) await handler({}, ctx);
		},
		timers() {
			const pending = live();
			return { count: pending.length, nextInMs: pending.length ? Math.min(...pending.map(t => t.due)) - now : undefined };
		},
		async shutdown() {
			for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
			for (const socket of subscribers) socket.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
			fs.rmSync(socketPath, { force: true });
			setSystemTime();
		},
	};
}
