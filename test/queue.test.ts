import { afterEach, describe, expect, it } from "bun:test";
import { createHarness, type Harness } from "./harness";

let h: Harness;

afterEach(async () => {
	await h.shutdown();
});

/** One worker finishing and starting again, delivered as a wake. */
async function wakeCycle(pane: string): Promise<void> {
	await h.setLive(pane, "idle", { event: true });
	await h.advance(800);
	await h.setLive(pane, "working", { event: true });
	await h.advance(1_000);
}

/** Fill the 20-wakes-per-10-minutes budget with wake-mode cycles of one pane. */
async function useUpWakeBudget(pane = "w1:p2"): Promise<void> {
	for (let i = 0; i < 20; i++) await wakeCycle(pane);
}

describe("while the session is busy", () => {
	it("holds settled updates, drops a pane that went back to work, and sends one wake at idle", async () => {
		h = await createHarness();
		h.setIdle(false);
		const readsAtStart = h.listCalls();
		await h.setLive("w1:p2", "idle", { event: true });
		await h.setLive("w1:p3", "idle", { event: true });
		await h.advance(2_000);
		expect(h.sent).toHaveLength(0);
		expect(h.status()).toBe("herdr-wake: 2 pane(s), 2 queued");
		expect(h.listCalls()).toBe(readsAtStart); // nothing can release, so the socket is left alone

		await h.setLive("w1:p2", "working", { event: true });
		expect(h.status()).toBe("herdr-wake: 2 pane(s), 1 queued");

		h.setIdle(true);
		await h.agentEnd();
		await h.advance(150);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toMatchObject({
			delivery: "wake",
			panes: [{ pane: "w1:p3", from: "working", to: "idle" }],
			options: { triggerTurn: true, deliverAs: "followUp" },
		});
		expect(h.status()).toBe("herdr-wake: 2 pane(s)");
	});

	it("injects a blocked alert at once as an aside and leaves settled updates queued", async () => {
		h = await createHarness();
		h.setIdle(false);
		await h.setLive("w1:p3", "idle", { event: true });
		await h.setLive("w1:p2", "blocked", { event: true });
		await h.advance(800);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toMatchObject({
			delivery: "aside",
			panes: [{ pane: "w1:p2", to: "blocked" }],
			options: { deliverAs: "aside" },
		});
		expect(h.status()).toBe("herdr-wake: 2 pane(s), 1 queued");
	});
});

describe("digest mode", () => {
	it("queues idle/done for the next turn without starting one, and shows in the watch list", async () => {
		h = await createHarness();
		expect(await h.tool({ action: "watch", pane: "w1:p2", mode: "digest" })).toContain("(digest)");
		await h.advance(250);
		expect(await h.tool({ action: "list" })).toContain("w1:p2 (worker-p2) -> idle|done|blocked [digest]");

		await h.setLive("w1:p2", "idle", { event: true });
		await h.advance(800);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]!.delivery).toBe("digest");
		expect(h.sent[0]!.options).toEqual({ triggerTurn: false, deliverAs: "nextTurn" });
		expect(h.sent[0]!.content).toContain("Settled pane digest");
	});

	it("folds into the wake when a turn is about to start anyway", async () => {
		h = await createHarness();
		await h.tool({ action: "watch", pane: "w1:p2", mode: "digest" });
		await h.advance(250);
		await h.setLive("w1:p2", "idle", { event: true });
		await h.setLive("w1:p3", "idle", { event: true });
		await h.advance(800);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]!.delivery).toBe("wake");
		expect(h.sent[0]!.panes.map(p => p.pane).sort()).toEqual(["w1:p2", "w1:p3"]);
		expect(h.sent[0]!.content).not.toContain("Settled pane digest");
	});
});

describe("live state check before a wake is sent", () => {
	it("drops an update when herdr says the pane is working again, even with no event", async () => {
		h = await createHarness();
		await h.setLive("w1:p2", "idle", { event: true });
		await h.setLive("w1:p2", "working");
		await h.advance(800);
		expect(h.sent).toHaveLength(0);
		expect(h.status()).toBe("herdr-wake: 2 pane(s)");
	});

	it("reports the live status, not the stale one from the event", async () => {
		h = await createHarness();
		await h.setLive("w1:p2", "idle", { event: true });
		await h.setLive("w1:p2", "blocked");
		await h.advance(800);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toMatchObject({ delivery: "wake", panes: [{ pane: "w1:p2", to: "blocked" }] });
	});

	it("keeps the queued state when herdr briefly reports `unknown`", async () => {
		h = await createHarness();
		await h.setLive("w1:p2", "idle", { event: true });
		await h.setLive("w1:p2", "unknown");
		await h.advance(800);
		expect(h.sent[0]!.panes).toMatchObject([{ pane: "w1:p2", to: "idle" }]);
	});
});

describe("wake rate cap", () => {
	it("holds the 21st wake without touching the socket, then releases it when the window clears", async () => {
		h = await createHarness();
		await useUpWakeBudget();
		expect(h.sent).toHaveLength(20);

		const reads = h.listCalls();
		await h.setLive("w1:p3", "idle", { event: true });
		await h.advance(800);
		expect(h.sent).toHaveLength(20);
		expect(h.listCalls()).toBe(reads);
		expect(h.status()).toBe("herdr-wake: 2 pane(s), 1 queued (throttled)");
		expect(h.notices.filter(n => n.level === "warning" && n.message.includes("holding queued updates"))).toHaveLength(1);

		await h.advance(10 * 60_000);
		expect(h.sent).toHaveLength(21);
		expect(h.sent[20]!.panes).toMatchObject([{ pane: "w1:p3", to: "idle" }]);
		expect(h.status()).toBe("herdr-wake: 2 pane(s)");
	});

	it("holds a digest entry that live state promotes to blocked, then sends it as a wake", async () => {
		h = await createHarness();
		await h.tool({ action: "watch", pane: "w1:p2", mode: "digest" });
		await useUpWakeBudget("w1:p3"); // p2 is digest-only: its cycles would not spend wake slots
		await h.setLive("w1:p2", "idle", { event: true }); // queued as a digest: needs no wake slot...
		await h.setLive("w1:p2", "blocked"); // ...until the live read says it is blocked
		const reads = h.listCalls();
		await h.advance(800);
		expect(h.listCalls()).toBeGreaterThan(reads);
		expect(h.sent).toHaveLength(20);
		expect(h.status()).toBe("herdr-wake: 2 pane(s), 1 queued (throttled)");

		await h.advance(10 * 60_000);
		expect(h.sent).toHaveLength(21);
		expect(h.sent[20]).toMatchObject({ delivery: "wake", panes: [{ pane: "w1:p2", to: "blocked" }] });
	});
});

describe("user control guards (abort cooldown, composer draft, continuation)", () => {
	it("holds wakes and drops auto ticks after an aborted turn, releasing early once the user submits input", async () => {
		h = await createHarness();
		await h.command("auto 1m");
		h.setIdle(false);
		await h.setLive("w1:p2", "done", { event: true });
		await h.advance(800);
		expect(h.sent).toHaveLength(0);

		// User hits Esc / cancels ask: agent_end arrives with stopReason === "aborted".
		h.setIdle(true);
		await h.agentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });
		await h.advance(5_000);
		expect(h.sent).toHaveLength(0); // held during the 15s post-abort cooldown

		// User submits a prompt before the 15s cooldown expires, clearing the hold for the next settle.
		h.setIdle(false);
		await h.input("actually hold #6228");
		await h.agentStart();
		h.setIdle(true);
		await h.agentEnd({ messages: [{ role: "assistant", stopReason: "stop" }] });
		await h.advance(150);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]!.panes).toMatchObject([{ pane: "w1:p2", to: "done" }]);

		// An aborted turn right before an auto tick also drops that tick instead of hijacking the session.
		await h.setLive("w1:p3", "done");
		await h.agentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });
		await h.advance(10_000); // lands on the 1m auto tick inside the 15s abort cooldown
		expect(h.sent).toHaveLength(1);
	});

	it("releases held wakes automatically once the 15s post-abort cooldown elapses", async () => {
		h = await createHarness();
		h.setIdle(false);
		await h.setLive("w1:p2", "done", { event: true });
		h.setIdle(true);
		await h.agentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });
		await h.advance(14_000);
		expect(h.sent).toHaveLength(0);
		await h.advance(2_000);
		expect(h.sent).toHaveLength(1);
	});

	it("waits while the user has a draft in the composer or an open plan review, without blocking digest queueing", async () => {
		h = await createHarness();
		await h.tool({ action: "watch", pane: "w1:p3", mode: "digest" });
		await h.advance(250);

		h.setEditorText("half-typed prompt");
		await h.setLive("w1:p3", "done", { event: true });
		await h.advance(800);
		expect(h.sent).toHaveLength(1); // digest rides on nextTurn without interrupting typing
		expect(h.sent[0]!.delivery).toBe("digest");

		await h.setLive("w1:p2", "done", { event: true });
		await h.advance(3_000);
		expect(h.sent).toHaveLength(1); // active wake waits while the composer has text

		h.setEditorText("   ");
		h.setPlanReview(true);
		await h.advance(2_000);
		expect(h.sent).toHaveLength(1); // still held while plan review is open

		h.setPlanReview(false);
		await h.advance(1_100);
		expect(h.sent).toHaveLength(2);
		expect(h.sent[1]!.delivery).toBe("wake");
	});

	it("skips the immediate settle flush when agent_end reports willContinue or awaitingAsyncWork", async () => {
		h = await createHarness();
		h.setIdle(false);
		await h.setLive("w1:p2", "done", { event: true });
		await h.advance(2_000); // sits on the 1,000ms idle poll

		h.setIdle(true);
		await h.agentEnd({ willContinue: true });
		await h.advance(150);
		expect(h.sent).toHaveLength(0); // did not shorten the 1,000ms poll to 100ms
	});
});

describe("triage metadata in wakes", () => {
	it("records actual working duration (excluding queue hold time) and focused state", async () => {
		h = await createHarness({ statuses: { "w1:p2": "idle" } });
		await h.setLive("w1:p2", "working", { event: true });
		await h.advance(4_200);

		h.setIdle(false); // manager is busy for 30s AFTER the worker already settled
		await h.setLive("w1:p2", "idle", { event: true, focused: true });
		await h.advance(30_000);
		expect(h.sent).toHaveLength(0);

		h.setIdle(true);
		await h.agentEnd();
		await h.advance(150);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]!.panes[0]).toMatchObject({
			pane: "w1:p2",
			from: "working",
			to: "idle",
			worked: "4.2s",
			focused: true,
		});
		expect(h.sent[0]!.content).toContain("w1:p2 (worker-p2): working -> idle (worked 4.2s, focused)");
	});
});
