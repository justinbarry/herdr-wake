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
- **Waits for the manager to be free.** `idle` / `done` updates queue while the session is mid-turn and go out as one batched wake once it is idle. Updates from many workers become one turn, not many.
- **Flapping is filtered.** A pane that goes back to `working` before its update is delivered is dropped from the queue, and queued entries are re-checked against live `agent.list` before they spend a turn.
- **`blocked` is urgent.** A blocked pane is injected at the manager's next step boundary instead of waiting for idle.
- **Digest mode.** Panes watched with `mode: "digest"` queue their idle/done updates for the manager's next turn without starting one.
- **Rate limited.** At most 20 wakes per 10 minutes, as an agent-to-agent ping-pong guard. Pane updates over the cap are held and released when the window clears rather than discarded. (`/herdr auto` ticks that hit the cap are skipped, since the next tick re-reads live state.)
- **Status only.** Wake text carries pane ids and state changes, never pane text. Pane output is untrusted, so the model reads it itself with `herdr agent read` (or hands it to a subagent).
- **Manager guidance.** While armed, a short standing note is added to the system prompt: give independent tasks their own herdr worktree, prefer event-driven follow-up over waiting, and hand heavy output or diff review to a background `task` subagent.
- **Review on demand or on a cadence.** `/herdr`, `/herdr check` and `/herdr auto` (below).

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

By default it watches every other agent pane in the manager's workspace and in the rest of its worktree group (the primary workspace and its linked-worktree workspaces: every workspace on the same repo).

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
| `/herdr` (or `/herdr status`) | List open agent panes: status, how each is watched, and any held update. No model turn. |
| `/herdr check` | Submit that snapshot to the model with a review prompt: read each non-working pane, report one line per pane, never answer a blocked pane's dialog. |
| `/herdr auto [interval]` | Repeat the review on a cadence: `90s`, `10m`, `2h` (bare number = minutes; 1m to 24h; default 10m). |
| `/herdr auto off` | Stop it. The cadence is per process and is not saved. |

An auto-check only runs when the session is idle: a tick that lands while the manager is busy is **dropped**, not delayed. It also stays quiet unless some pane is not `working` (or has a held update) and pane states differ from the last review. Each one spends a slot of the same 20-per-10-minutes wake budget.

### How an update is delivered

| Pane change | Manager idle | Manager mid-turn |
|---|---|---|
| `working` → `idle` / `done` (wake mode) | one batched turn after a 750 ms debounce | held until idle, then one batched turn |
| `working` → `idle` / `done` (digest mode) | queued for the next turn, no turn started | held until idle, then queued the same way |
| any → `blocked` | one batched turn | injected at the next step boundary |

---

## Known limits

- Tested against a fake herdr socket with one manager and synthetic workers. Production herdr capacity is unmeasured.
- Every armed manager watches every other agent pane in its repo group, including other managers, so several armed managers in one repo wake each other. The rate cap bounds this but does not prevent it.
- A change in the set of panes costs a `workspace.list`, two `agent.list` calls and a resubscribe. The 200 ms debounce does not merge changes spaced wider than that.
- `blocked` alerts share the 20-per-10-minutes cap, so a long storm of updates can hold one.
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
