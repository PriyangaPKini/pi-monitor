# pi-monitor

> **Experimental:** this pi extension is an early personal experiment. APIs, storage format, and UI behavior may change without notice.

`pi-monitor` adds a `/monitor` command to pi. It opens an interactive TUI board showing queued, in-progress, blocked, and completed pi work across recent sessions.

![pi-monitor screenshot](assets/screenshot.svg)

## Install

```bash
pi install git:github.com/PriyangaPKini/pi-monitor
```

Then restart pi or run `/reload`.

## Use

```text
/monitor
```

Controls:

- `r` refresh
- arrow keys select items; columns scroll to keep the selection in view
- `enter` toggle details
- `q` or `esc` close

## Notes

- Maintains a central live registry under `~/.pi/agent/monitor/` from pi lifecycle events emitted by each loaded extension process.
- Reads recent pi session files from `~/.pi/agent/sessions/` as a fallback for sessions that are not in the live registry.
- Records live session rows, pending queued messages, and running subagents (the `subagent` and `subagent_wait` tools from the pi-subagents extension). Built-in tool calls such as bash are not tracked.
- Shows **Blocked** only from live registry signals, such as a live Pi turn ending with text that asks for input or a provider error.
- Shows any session whose process is still heartbeating under **In Progress**, whether it is mid-turn or waiting for input. Mid-turn rows are bright with a filled marker; idle-but-alive rows are dimmed with a hollow one. This is derived from the registry heartbeat at render time and is never written to the state file.
- Intended for interactive TUI mode.

## License

MIT
