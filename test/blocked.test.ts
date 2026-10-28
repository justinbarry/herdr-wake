import { afterEach, describe, expect, it } from "bun:test";
import { createHarness, type Harness } from "./harness";

let h: Harness;

afterEach(async () => {
	await h.shutdown();
});

describe("blocked-pane alert", () => {
	it("appears the moment a pane blocks, even mid-turn, and clears when it unblocks", async () => {
		h = await createHarness();
		h.setIdle(false);
		await h.setLive("w1:p2", "blocked", { event: true });
		expect(h.widget()).toEqual(["herdr-wake: 1 blocked: w1:p2 (worker-p2). /herdr focus jumps to the first."]);
		expect(h.notices.filter(n => n.level === "warning" && n.message.includes("w1:p2 (worker-p2) is blocked"))).toHaveLength(1);

		await h.setLive("w1:p2", "working", { event: true });
		expect(h.widget()).toBeUndefined();
	});

	it("lists several blocked panes oldest first, and abbreviates past three", async () => {
		h = await createHarness({ panes: ["w1:p2", "w1:p3", "w1:p4", "w1:p5"] });
		for (const pane of ["w1:p3", "w1:p2", "w1:p5", "w1:p4"]) await h.setLive(pane, "blocked", { event: true });
		expect(h.widget()![0]).toContain("4 blocked: w1:p3 (worker-p3), w1:p2 (worker-p2), w1:p5 (worker-p5) +1 more");
	});

	it("shows a pane that was already blocked when the extension started, without a notice", async () => {
		h = await createHarness({ statuses: { "w1:p3": "blocked" } });
		expect(h.widget()?.[0]).toContain("1 blocked: w1:p3 (worker-p3)");
		expect(h.notices).toEqual([]);
	});

	it("stays quiet for a pane whose watch leaves `blocked` out, and drops muted panes", async () => {
		h = await createHarness();
		await h.tool({ action: "watch", pane: "w1:p2", until: ["idle"] });
		await h.advance(250);
		await h.setLive("w1:p2", "blocked", { event: true });
		expect(h.widget()).toBeUndefined();
		expect(h.notices).toEqual([]);

		await h.setLive("w1:p3", "blocked", { event: true });
		expect(h.widget()).toBeDefined();
		await h.tool({ action: "unwatch", pane: "w1:p3" });
		expect(h.widget()).toBeUndefined();
	});
});

describe("/herdr focus", () => {
	it("jumps to the oldest blocked pane by default", async () => {
		h = await createHarness();
		await h.setLive("w1:p3", "blocked", { event: true });
		await h.setLive("w1:p2", "blocked", { event: true });
		await h.command("focus");
		expect(h.requests.filter(r => r.method === "agent.focus")).toEqual([{ method: "agent.focus", params: { target: "w1:p3" } }]);
		expect(h.notices.at(-1)!.message).toBe("herdr-wake: focused w1:p3");
	});

	it("takes a pane id or agent name and keeps the pane id's case", async () => {
		h = await createHarness({ panes: ["w1:pA", "w1:p2"] });
		await h.command("focus w1:pA");
		await h.command("focus worker-p2");
		expect(h.requests.filter(r => r.method === "agent.focus").map(r => r.params.target)).toEqual(["w1:pA", "w1:p2"]);
	});

	it("says so, and sends nothing, when nothing is blocked or the pane is unknown", async () => {
		h = await createHarness();
		await h.command("focus");
		expect(h.notices[0]!.message).toContain("no blocked pane");
		await h.command("focus w9:p9");
		expect(h.notices[0]!).toMatchObject({ level: "warning", message: expect.stringContaining("no live agent pane matches w9:p9") });
		expect(h.requests.some(r => r.method === "agent.focus")).toBe(false);
	});
});

// `ask` parks the whole session on the user, so it is only requested when nothing else needs the session.
describe("wake text for a blocked pane", () => {
	it("tells the manager not to park on `ask` while other panes are still working", async () => {
		h = await createHarness();
		await h.setLive("w1:p2", "blocked", { event: true });
		await h.advance(800);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]!.content).toContain("do not park this session on the `ask` tool");
	});

	it("asks for the `ask` tool once nothing else is working or queued", async () => {
		h = await createHarness({ panes: ["w1:p2"] });
		await h.setLive("w1:p2", "blocked", { event: true });
		await h.advance(800);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]!.content).toContain("put it to the user with the `ask` tool");
		expect(h.sent[0]!.content).not.toContain("do not park");
	});

	it("counts a queued update as other work", async () => {
		h = await createHarness();
		await h.setLive("w1:p3", "idle", { event: true });
		await h.setLive("w1:p2", "blocked", { event: true });
		h.setIdle(false); // the settled update stays queued while the blocked alert goes out as an aside
		await h.advance(800);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toMatchObject({ delivery: "aside" });
		expect(h.sent[0]!.content).toContain("do not park this session on the `ask` tool");
	});

	it("applies the same rule to `/herdr check`", async () => {
		h = await createHarness();
		await h.setLive("w1:p3", "blocked");
		await h.command("check");
		expect(h.users[0]).toContain("do not park this session on the `ask` tool"); // p2 is still working

		await h.setLive("w1:p2", "blocked");
		await h.command("check");
		expect(h.users[1]).toContain("put it to me with the `ask` tool");
	});
});
