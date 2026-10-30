# herdr-wake (`herdr-wake`)

A plugin for [Oh My Pi (OMP)](https://omp.sh) that wakes an OMP session when other [herdr](https://herdr.dev) agent panes finish or block, so one session can manage the agents running beside it.

Start OMP inside a herdr pane with `--herdr-wake`, hand work to agents in other panes, and keep talking to your manager session. When a worker goes idle, finishes, or needs you, the manager is told, without polling and without a `herdr agent wait` blocking its turn.

```
 herdr workspace
 ┌────────────────────┐   events.subscribe   ┌──────────────────────────────┐
 │ worker pane  (idle)├─────────────────────►│ herdr-wake (in manager omp)  │
 │ worker pane  (blocked)                    │  queue → live check → wake   │
 └────────────────────┘                      └──────────────┬───────────────┘
                                                            ▼
                                     manager session: one batched turn when idle,
                                     `blocked` alerts injected mid-turn
```

Inert unless OMP runs inside a herdr pane **and** is started with `--herdr-wake`.

---

## Features

- **Event-driven.** Subscribes to herdr's agent-status events over its socket. No polling loop, and no changes to OMP or herdr.
- **Waits for the manager (and you) to be free.** `idle` / `done` updates queue while the session is mid-turn, while you have a draft in the composer or an open plan review, or during a 15 s cooldown after `Esc` / cancelling `ask`, then go out as one batched wake once clear. Updates from many workers become one turn, not many.
- **Flapping is filtered.** A pane that goes back to `working` before its update is delivered is dropped from the queue, and queued entries are re-checked against live `agent.list` before they spend a turn.
- **`blocked` is urgent.** A blocked pane is injected at the manager's next step boundary instead of waiting for idle, and you are alerted at once, independent of the model: a widget above the editor and a notice name the pane, and `/herdr focus` jumps to it so you can answer in the pane itself.
- **Digest and mute controls.** Panes watched with `mode: "digest"` queue their idle/done updates for the manager's next turn without starting one; `/herdr mute <pane>` and `/herdr unmute <pane>` (or `herdr_watch`) silence user-driven panes. Watch settings, mutes, and `/herdr auto` persist in the session across `--resume`.
- **Peer managers stay out.** While armed, the manager tags its pane with a display-only `herdr_wake=manager` metadata token (cleared on shutdown) so multiple armed managers in the same repo group do not wake each other unless explicitly watched.
- **Rate limited.** At most 20 wakes per 10 minutes, as an agent-to-agent ping-pong guard. Pane updates over the cap are held and released when the window clears rather than discarded. (`/herdr auto` ticks that hit the cap are skipped, since the next tick re-reads live state.)
- **Status + triage metadata only.** Wake text carries pane ids, state changes, observed `working` duration, and whether the pane is currently `focused` in herdr — never untrusted pane text. The model reads transcripts itself with `herdr agent read` (or hands heavy output to a subagent).
- **Manager guidance + inline-drift nudge.** While armed, a standing note in the system prompt routes research, bug/incident investigation, PR review, planning, and implementation alike to dedicated herdr worktree sessions ("spawn first, brief thin — never pre-investigate in the manager before briefing"), unwatching panes you tell it you are driving directly, and reserving `task` subagents for digesting large worker transcripts or non-git fallbacks. If the manager still drifts into 3+ inline research/query tool calls in one turn without successfully dispatching a worker, a one-shot `tool_result` `additionalContext` reminder redirects it to spin up a herdr worktree session without blocking explicit inline requests. For a blocked pane the manager reads what it is asking and, only when no other watched pane is working or queued, puts the question to you with the `ask` tool (restated in its own words, never answering the dialog itself). `ask` parks the whole session until you answer, so otherwise it notes the block in a line and keeps orchestrating. Muted and out-of-scope panes don't count as busy: the manager gets no updates from them, so parking on `ask` doesn't hold anything up.
- **Review on demand or on a cadence.** `/herdr`, `/herdr check`, `/herdr auto`, `/herdr focus`, `/herdr mute` and `/herdr unmute` (below).

---

## Requirements

- [herdr](https://herdr.dev) with its socket API. Tested with 0.9.5.
- OMP 18.4.9 or newer: type-checked against 18.4.9 and 18.13.3, run on 18.13.x.
- OMP must run inside a herdr pane (herdr sets `HERDR_ENV`, `HERDR_SOCKET_PATH` and `HERDR_PANE_ID`).

---

## Installation

### Directly via OMP (recommended)

```bash
omp plugin install github:justinbarry/herdr-wake
```

### Local development / symlink

```bash
git clone https://github.com/justinbarry/herdr-wake.git
omp plugin link ./herdr-wake
```

### Zero-install (single session)

```bash
omp -e /path/to/herdr-wake --herdr-wake
```

`omp --plugin-dir` does not work here: omp rejects `--herdr-wake` as an unknown flag before it loads the plugin. Use `-e` for a one-off session, or install or link the plugin.

---

## Usage

Start a manager session inside a herdr pane:

```bash
omp --herdr-wake            # add --resume <session> to continue one
```

The status bar shows `herdr-wake: 3 pane(s)`, plus `2 queued` while updates are held, `(throttled)` at the rate cap, and `auto 10m` when a cadence is on.

By default it watches every other non-manager agent pane in the manager's workspace and in the rest of its worktree group (the primary workspace and its linked-worktree workspaces: every workspace on the same repo).

### `herdr_watch` tool

The model can adjust what it watches.

| Argument | Meaning |
|---|---|
| `action` | `watch`, `unwatch` or `list` |
| `pane` | pane id (`w1:p2`), live agent name, or an agent kind when only one pane runs it |
| `until` | states that wake for this pane: any of `idle`, `done`, `blocked` (default: all three) |
| `mode` | `wake` (default) or `digest` |

### Commands

| Command | Effect |
|---|---|
| `/herdr` (or `/herdr status`) | List open agent panes: status, focus, how each is watched, and any held update. No model turn. |
| `/herdr check` | Submit that snapshot to the model with a review prompt: read each non-working, non-muted pane, report one line per pane, never answer a blocked pane's dialog. |
| `/herdr auto [interval]` | Repeat the review on a cadence: `90s`, `10m`, `2h` (bare number = minutes; 1m to 24h; default 10m). Saved in the session across `--resume`. |
| `/herdr auto off` | Stop the cadence (and save `off` in the session). |
| `/herdr focus [pane]` | Jump to a pane in herdr (default: the oldest blocked one) so you can answer its dialog there. Takes a pane id or agent name. |
| `/herdr mute <pane>` | Mute a pane (drops any held update and clears its blocked alert). Takes a pane id or agent name. |
| `/herdr unmute <pane>` | Resume watching a muted pane. |

An auto-check only runs when the session is idle and you are not actively typing or inside the post-`Esc` cooldown: a tick that lands while busy is **dropped**, not delayed. It tracks per-pane `completion_seq` / `state_change_seq` so transitions already delivered by an event wake, `done → idle` sight flips, pane closures, and `→ working` transitions do not spend a turn, and the prompt names only the panes that changed since the last review. Each review spends a slot of the same 20-per-10-minutes wake budget.
### How an update is delivered

| Pane change | Manager idle | Manager mid-turn |
|---|---|---|
| `working` → `idle` / `done` (wake mode) | one batched turn after a 750 ms debounce | held until idle, then one batched turn |
| `working` → `idle` / `done` (digest mode) | queued for the next turn, no turn started | held until idle, then queued the same way |
| any → `blocked` | one batched turn | injected at the next step boundary |

---

## Known limits

- Tested against a fake herdr socket and smoke-verified against herdr 0.9.5; high-pane-count capacity is unmeasured.
- Refresh uses `session.snapshot` (falling back to `workspace.list` + `agent.list`); when the watched pane set changes, resubscribing takes one extra reconciliation read. The 200 ms refresh debounce does not merge lifecycle bursts spaced wider than that.
- If a manager process is `SIGKILL`ed before `session_shutdown` clears its `herdr_wake=manager` token, a worker later started in that exact pane stays skipped until explicitly watched (`herdr_watch`) or the pane closes.
- `blocked` model turns share the 20-per-10-minutes cap (the editor widget and warning notice still fire immediately).
- Send failures are logged, not retried.

---

## Development

```bash
bun install
bun test               # fake herdr socket + fake clock: no herdr or model needed
bun run check:types
```

`test/harness.ts` runs the real extension against a fake socket, a fake OMP session and a simulated clock, so the 10-minute rate-cap window costs milliseconds. `test/plugin-discovery.test.ts` loads the checkout as a plugin through OMP's own extension loader.

## License

MIT
