# pi-monitor

> **Experimental:** this pi extension is an early personal experiment. APIs, storage format, and UI behavior may change without notice.

`pi-monitor` adds a `/monitor` command to pi. It opens an interactive TUI board of pi sessions across recent work, in four columns: **Needs Input**, **Working**, **Idle**, and **Completed**.

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
- Records live session rows and running subagents (the `subagent` and `subagent_wait` tools from the pi-subagents extension). Built-in tool calls such as bash are not tracked, and queued messages are not tracked.
- **Needs Input** comes only from live registry signals: a turn ending with text that asks for input, or a provider error.
- **Working** is a session mid-turn, **Idle** is one whose process is still heartbeating between turns, and **Completed** is one that has finished. Idle is derived from the registry heartbeat at render time and is never written to the state file, so sessions running an older build are placed correctly without needing a restart.
- Intended for interactive TUI mode.

## License

MIT
