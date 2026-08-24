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
- arrow keys select items
- `enter` toggle details
- `q` or `esc` close

## Notes

- Stores monitor state under `~/.pi/agent/monitor/`.
- Reads recent pi session files from `~/.pi/agent/sessions/`.
- Hides bash items from the board.
- Shows likely "needs input" sessions under **Blocked** when session text indicates confirmation, permission, or user input is needed.
- Intended for interactive TUI mode.

## License

MIT
