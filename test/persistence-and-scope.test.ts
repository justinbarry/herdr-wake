import { afterEach, describe, expect, it } from "bun:test";
import { createHarness, type Harness } from "./harness";

let h: Harness | undefined;

afterEach(async () => {
	if (h) {
		await h.shutdown();
		h = undefined;
	}
});

describe("session state persistence", () => {
	it("persists auto cadence, mutes, and custom watches across session restarts without shutdown wiping them", async () => {
		h = await createHarness({ panes: ["w1:p2", "w1:p3", "w1:p4"] });
		await h.command("auto 2m");
		await h.command("mute w1:p2");
		await h.tool({ action: "watch", pane: "w1:p3", until: ["blocked"], mode: "digest" });
		await h.advance(250);

		const saved = h.entries();
		expect(saved.length).toBeGreaterThanOrEqual(3);
		await h.shutdown();
		h = undefined;

		// Simulate `omp --herdr-wake --resume`: rehydrate from the saved branch entries.
		h = await createHarness({ panes: ["w1:p2", "w1:p3", "w1:p4"], branchEntries: saved });
		expect(h.status()).toBe("herdr-wake: 2 pane(s), auto 2m");
		expect(h.timers()).toEqual({ count: 1, nextInMs: 2 * 60_000 });
		const listed = await h.tool({ action: "list" });
		expect(listed).toContain("w1:p2 (worker-p2) -> muted");
		expect(listed).toContain("w1:p3 (worker-p3) -> blocked [digest]");
		expect(listed).toContain("w1:p4 (worker-p4) -> idle|done|blocked");

		// Muted w1:p2 stays silent; w1:p3 ignores idle because `until` was restored as ["blocked"].
		await h.setLive("w1:p2", "done", { event: true });
		await h.setLive("w1:p3", "idle", { event: true });
		await h.advance(1_000);
		expect(h.sent).toHaveLength(0);

		// Switching to a fresh `/new` session resets to defaults; switching back restores saved state.
		await h.switchSession([]);
		await h.advance(250);
		expect(h.status()).toBe("herdr-wake: 3 pane(s)");
		expect(h.timers().count).toBe(0);

		await h.switchSession(saved);
		await h.advance(250);
		expect(h.status()).toBe("herdr-wake: 2 pane(s), auto 2m");
	});
});

describe("snapshot bootstrap, worktree lifecycle, and peer managers", () => {
	it("bootstraps via session.snapshot, skips resubscribe when the watched set is unchanged, and falls back when snapshot is unsupported", async () => {
		h = await createHarness();
		expect(h.requests.some(r => r.method === "session.snapshot")).toBe(true);
		expect(h.requests.some(r => r.method === "workspace.list")).toBe(false);

		const subsBefore = h.requests.filter(r => r.method === "events.subscribe").length;
		await h.setWorkspaces([{ workspace_id: "w1", label: "renamed", worktree: { repo_key: "repo-main" } }], {
			event: "workspace_renamed",
		});
		await h.advance(250);
		expect(h.requests.filter(r => r.method === "events.subscribe")).toHaveLength(subsBefore); // 1 snapshot read, 0 resubscribes

		await h.shutdown();
		h = await createHarness({ disableSnapshot: true });
		expect(h.requests.some(r => r.method === "workspace.list")).toBe(true);
		expect(h.status()).toBe("herdr-wake: 2 pane(s)");
	});

	it("advertises manager metadata, skips peer armed managers unless explicitly watched, and clears metadata on shutdown", async () => {
		h = await createHarness({
			agents: [
				{ pane_id: "w1:p2", workspace_id: "w1", agent_status: "working", agent: "worker-p2" },
				{
					pane_id: "w1:p3",
					workspace_id: "w1",
					agent_status: "working",
					agent: "omp",
					tokens: { herdr_wake: "manager" },
				},
			],
		});
		expect(h.paneTokens("w1:p1")).toEqual({ herdr_wake: "manager" });
		expect(h.status()).toBe("herdr-wake: 1 pane(s)");

		await h.command("");
		expect(h.notices[0]!.message).toContain("w1:p3 (omp): working, manager (not watched)");

		// Peer manager transitioning does not wake this manager...
		await h.setLive("w1:p3", "done", { event: true });
		await h.advance(800);
		expect(h.sent).toHaveLength(0);

		// ...unless explicitly watched via herdr_watch.
		await h.tool({ action: "watch", pane: "w1:p3" });
		await h.advance(250);
		expect(h.status()).toBe("herdr-wake: 2 pane(s)");

		// Shutdown clears the manager's own token so a later worker in the same pane is watched normally.
		await h.shutdown();
		const clearReq = h.requests.findLast(r => r.method === "pane.report_metadata");
		expect(clearReq).toEqual({
			method: "pane.report_metadata",
			params: { pane_id: "w1:p1", source: "herdr-wake", tokens: { herdr_wake: null } },
		});
		h = undefined;
	});

	it("discovers a newly created linked-worktree workspace on worktree_created and ignores other repos", async () => {
		h = await createHarness({ panes: ["w1:p2"] });
		expect(h.status()).toBe("herdr-wake: 1 pane(s)");

		await h.setWorkspaces([
			{ workspace_id: "w1", label: "main", worktree: { repo_key: "repo-main" } },
			{ workspace_id: "w2", label: "feature-wt", worktree: { repo_key: "repo-main" } },
			{ workspace_id: "w9", label: "unrelated", worktree: { repo_key: "other-repo" } },
		]);
		await h.upsertAgent({ pane_id: "w2:p1", workspace_id: "w2", agent_status: "working", agent: "wt-worker" });
		await h.upsertAgent(
			{ pane_id: "w9:p1", workspace_id: "w9", agent_status: "working", agent: "other-worker" },
			{ event: "worktree_created" },
		);
		await h.advance(250);
		expect(h.status()).toBe("herdr-wake: 2 pane(s)");

		await h.setLive("w2:p1", "done", { event: true });
		await h.setLive("w9:p1", "done", { event: true });
		await h.advance(800);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]!.content).toContain("w2:p1 (wt-worker) in workspace feature-wt: working -> done");
	});
});

describe("manager research delegation guardrail", () => {
	it("nudges once on the 3rd inline research call, ignores orchestration/subagents, and only disarms when delegation succeeds", async () => {
		h = await createHarness();
		await h.agentStart();

		// Orchestration calls (herdr CLI, /tmp brief staging, subagent calls) never count as inline drift.
		expect(await h.toolResult("bash", { command: "herdr agent read w1:p2 --lines 80" })).toBeUndefined();
		expect(await h.toolResult("write", { path: "/tmp/brief.txt", content: "investigate" })).toBeUndefined();
		expect(await h.toolResult("grep", { pattern: "swaarm" }, { agentKind: "sub" })).toBeUndefined();
		expect(await h.toolResult("read", { path: "src/index.ts" }, { agentKind: "sub" })).toBeUndefined();
		expect(await h.toolResult("bash", { command: "git log -n 5" }, { agentKind: "sub" })).toBeUndefined();

		// Failed `herdr worktree create` or failed `task` must NOT suppress the nudge when the manager then falls back to inline research.
		expect(
			await h.toolResult("bash", { command: "herdr worktree create --branch dup --no-focus" }, { isError: true }),
		).toBeUndefined();
		expect(
			await h.toolResult(
				"bash",
				{ command: "herdr worktree create --branch dup --no-focus 2>&1 | head -5" },
				{ text: '{"id":"cli","error":{"code":"branch_exists","message":"exists"}}' },
			),
		).toBeUndefined();
		expect(await h.toolResult("task", { tasks: [] }, { isError: true })).toBeUndefined();

		// Inline research in the main session: calls 1 and 2 pass silently, call 3 attaches a non-blocking nudge.
		expect(await h.toolResult("write", { path: "xd://mcp__linear_get_issue", content: "{}" })).toBeUndefined();
		expect(await h.toolResult("bash", { command: "gh pr list --state open" })).toBeUndefined();
		const third = await h.toolResult("write", { path: "xd://mcp__planetscale_execute_read_query", content: "{}" });
		expect(third?.additionalContext).toContain("herdr worktree create");

		// One-shot per turn: call 4 is not spammed again, and a successful dispatch on the next turn suppresses it.
		expect(await h.toolResult("read", { path: "README.md" })).toBeUndefined();

		await h.agentStart();
		expect(await h.toolResult("grep", { pattern: "foo" })).toBeUndefined();
		expect(
			await h.toolResult(
				"bash",
				{ command: "herdr worktree create --branch investigate-foo --no-focus" },
				{ text: '{"id":"cli","result":{"workspace_id":"w2"}}' },
			),
		).toBeUndefined();
		expect(await h.toolResult("read", { path: "a.ts" })).toBeUndefined();
		expect(await h.toolResult("read", { path: "b.ts" })).toBeUndefined();
		expect(await h.toolResult("read", { path: "c.ts" })).toBeUndefined(); // successful dispatch -> no nudge
	});
});
