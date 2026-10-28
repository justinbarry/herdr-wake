# herdr-wake

An [omp](https://github.com/can1357/oh-my-pi) extension that wakes an omp session when other [herdr](https://herdr.dev) agent panes finish or block. It makes one omp session a manager of the agents running beside it.

Inert unless omp is started inside a herdr pane with `--herdr-wake`.

## Install

```sh
omp plugin install github:<owner>/herdr-wake   # or: omp plugin link /path/to/herdr-wake
omp --herdr-wake                               # add --resume <session> to continue one
```

The extension imports `@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-utils`, which omp provides at runtime; the peer dependencies only matter for type checking.

## What it does

- Subscribes to herdr's `agent_status_changed` events for the other agent panes in this workspace and the rest of its worktree group (every workspace on the same repo).
- `idle`/`done` updates wait in a queue while the session is mid-turn and go out as one batched wake once it is idle. A pane that goes back to `working` first is dropped from the queue.
- `blocked` alerts are injected at the next step boundary instead of waiting for idle.
- Queued entries are re-checked against live `agent.list` before they spend a turn.
- At most 20 wakes per 10 minutes (agent-to-agent ping-pong guard). Updates over the cap are held, not dropped.
- Wake text is status only. Pane text is untrusted and is never injected; the model reads it itself with `herdr agent read`.
- While armed, `manager.md` is appended to the system prompt: prefer one herdr worktree per independent task, prefer event-driven follow-up over waiting, delegate heavy output to a background `task` subagent.

## Controls

| | |
|---|---|
| `herdr_watch` tool | `watch` / `unwatch` / `list` panes; `until` picks the states that wake; `mode: "digest"` delivers idle/done on the next turn without starting one |
| `/herdr` | list open agent panes and how they are watched (no model turn) |
| `/herdr check` | submit the live snapshot to the model with a review prompt |
| `/herdr auto [interval\|off]` | repeat that review on a cadence (`90s`, `10m`, `2h`; 1m-24h). A tick that lands while the session is busy is dropped, not delayed |

The status bar shows `herdr-wake: N pane(s), K queued (throttled), auto 10m`.

## Develop

```sh
bun install
bun run check
```

## Known limits

- Measured only against a fake socket with one manager and synthetic workers; production herdr capacity is unmeasured.
- Every armed manager watches every other agent pane in the repo group, including other managers, so several armed managers in one repo wake each other.
- Each pane-set change costs a `workspace.list`, two `agent.list` calls and a resubscribe; the 200 ms debounce does not merge events spaced wider than that.
- Send failures are logged, not retried.
