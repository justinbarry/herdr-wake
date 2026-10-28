import { afterEach, describe, expect, it } from "bun:test";
import { createHarness, type Harness } from "./harness";

const TEN_MIN = 10 * 60_000;

let h: Harness;

afterEach(async () => {
	await h.shutdown();
});

async function wakeCycle(pane: string): Promise<void> {
	await h.setLive(pane, "idle", { event: true });
	await h.advance(800);
	await h.setLive(pane, "working", { event: true });
	await h.advance(1_000);
}

describe("/herdr and /herdr check", () => {
	it("lists every live agent pane with its watch mode and any held update", async () => {
		h = await createHarness();
		await h.tool({ action: "watch", pane: "w1:p2", mode: "digest" });
		await h.advance(250);
		h.setIdle(false);
		await h.setLive("w1:p3", "idle", { event: true });
		await h.advance(800); // held: the session is busy
		await h.command("");
		const text = h.notices[0]!.message;
		expect(text).toContain("2 agent pane(s), 2 watched, 1 queued");
		expect(text).toContain("w1:p2 (worker-p2): working, idle|done|blocked (digest)");
		expect(text).toContain("w1:p3 (worker-p3): idle, idle|done|blocked, queued working -> idle");
	});

	it("submits the live snapshot as a plain user prompt", async () => {
		h = await createHarness();
		await h.command("check");
		expect(h.users).toHaveLength(1);
		expect(h.users[0]).toStartWith("Check on my open herdr agent sessions");
		expect(h.users[0]).toContain("w1:p2 (worker-p2): working");
		expect(h.users[0]).not.toContain("Scheduled");
	});

	it("rejects unknown subcommands and stray arguments", async () => {
		h = await createHarness();
		for (const args of ["bogus", "check now", "status now"]) {
			await h.command(args);
			expect(h.notices).toEqual([
				{ message: "Usage: /herdr [status|check|auto [<interval>|off]|focus [<pane>]]", level: "warning" },
			]);
		}
		expect(h.users).toHaveLength(0);
	});
});

describe("/herdr auto", () => {
	it("reviews on the cadence only when a pane is not working, and not again for unchanged states", async () => {
		h = await createHarness();
		await h.command("auto 10m");
		expect(h.status()).toBe("herdr-wake: 2 pane(s), auto 10m");
		expect(h.timers()).toEqual({ count: 1, nextInMs: TEN_MIN });

		await h.advance(TEN_MIN); // every pane is working: nothing to look at
		expect(h.sent).toHaveLength(0);

		await h.setLive("w1:p2", "idle");
		await h.advance(TEN_MIN);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toMatchObject({ attribution: "agent", options: { triggerTurn: true, deliverAs: "followUp" } });
		expect(h.sent[0]!.content).toContain("Scheduled check");
		expect(h.sent[0]!.content).toContain("w1:p2 (worker-p2): idle");

		await h.advance(2 * TEN_MIN); // same idle pane, nothing changed: no repeat turn
		expect(h.sent).toHaveLength(1);

		await h.setLive("w1:p2", "working");
		await h.advance(TEN_MIN);
		await h.setLive("w1:p2", "idle"); // the same state after a working cycle is news again
		await h.advance(TEN_MIN);
		expect(h.sent).toHaveLength(2);
	});

	it("drops a tick that lands while the session is busy: no idle polling, no replay", async () => {
		h = await createHarness();
		await h.command("auto 10m");
		await h.setLive("w1:p3", "blocked");
		h.setIdle(false);
		await h.advance(TEN_MIN);
		expect(h.sent).toHaveLength(0);
		expect(h.timers()).toEqual({ count: 1, nextInMs: TEN_MIN }); // one full interval out, nothing sooner

		h.setIdle(true);
		await h.advance(30_000);
		expect(h.sent).toHaveLength(0); // going idle does not replay the dropped tick

		await h.advance(TEN_MIN - 30_000);
		expect(h.sent).toHaveLength(1); // the next tick reads live state and sees what the dropped one would have
		expect(h.sent[0]!.content).toContain("w1:p3 (worker-p3): blocked");
	});

	it("drops a tick when a turn starts while it is reading the pane list", async () => {
		h = await createHarness();
		await h.command("auto 10m");
		await h.setLive("w1:p2", "idle");
		h.holdList();
		await h.advance(TEN_MIN);
		h.setIdle(false);
		await h.releaseList();
		expect(h.sent).toHaveLength(0);
		expect(h.timers()).toEqual({ count: 1, nextInMs: TEN_MIN });
	});

	it("cannot dispatch from a stale tick after auto is switched off and on", async () => {
		h = await createHarness();
		await h.command("auto 10m");
		await h.setLive("w1:p2", "blocked");
		h.holdList();
		await h.advance(TEN_MIN); // a tick is now waiting on the pane list
		await h.command("auto off");
		await h.command("auto 10m");
		await h.releaseList();
		expect(h.sent).toHaveLength(0);
		expect(h.timers().count).toBe(1);
		expect(h.timers().nextInMs).toBeGreaterThan(TEN_MIN - 10_000);
	});

	it("stops cleanly on `off`", async () => {
		h = await createHarness();
		await h.command("auto 10m");
		await h.setLive("w1:p2", "idle");
		await h.command("auto off");
		expect(h.status()).toBe("herdr-wake: 2 pane(s)");
		expect(h.timers().count).toBe(0);
		await h.advance(60 * 60_000);
		expect(h.sent).toHaveLength(0);
	});

	it("rejects bad intervals without disturbing a running cadence", async () => {
		h = await createHarness();
		await h.command("auto 10m");
		for (const arg of ["30s", "2d", "banana", "25h"]) {
			await h.command(`auto ${arg}`);
			expect(h.notices[0]!.level).toBe("warning");
		}
		await h.command("auto 1m 2m");
		expect(h.notices[0]!.message).toStartWith("Usage:");
		expect(h.status()).toBe("herdr-wake: 2 pane(s), auto 10m");
		expect(h.timers()).toEqual({ count: 1, nextInMs: TEN_MIN });
	});

	it("shares the wake budget with event wakes: a tick is skipped at the cap and resumes when it clears", async () => {
		h = await createHarness();
		for (let i = 0; i < 20; i++) await wakeCycle("w1:p2");
		expect(h.sent).toHaveLength(20);

		await h.command("auto 1m");
		await h.setLive("w1:p3", "idle");
		await h.advance(8 * 60_000);
		expect(h.sent).toHaveLength(20); // every tick in the window is skipped

		await h.advance(3 * 60_000);
		expect(h.sent).toHaveLength(21);
		expect(h.sent[20]!.content).toContain("Scheduled check");
	});

	it("spends a wake slot: the next event wake is held once a tick took the last one", async () => {
		h = await createHarness();
		for (let i = 0; i < 19; i++) await wakeCycle("w1:p2");
		await h.command("auto 1m");
		await h.setLive("w1:p3", "idle");
		await h.advance(60_000);
		expect(h.sent).toHaveLength(20);
		expect(h.sent[19]!.content).toContain("Scheduled check");

		await h.setLive("w1:p2", "idle", { event: true });
		await h.advance(800);
		expect(h.sent).toHaveLength(20);
		expect(h.status()).toBe("herdr-wake: 2 pane(s), 1 queued (throttled), auto 1m");
	});
});
