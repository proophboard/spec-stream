# Logging

`spec-stream` logs to two sinks simultaneously so you can watch it live **and** inspect
what happened later.

## Sinks

### 1. Terminal (human-readable)
- Colorized when attached to a TTY; plain text otherwise (pipes, files, CI).
- One concise line per event received, per command started/finished, and per
  connection state change.
- Respects `logLevel` (`trace|debug|info|warn|error`).

Example:

```
17:42:03  info  ● connected   workspace=8f3c… channel=changelog:8f3c…
17:42:19  info  ▸ event       element-description-changed  element="Place Order" (command)
17:42:19  info  ⧗ debounce    key=element:9a1b… wait=8000ms
17:42:27  info  ▶ run         rule=spec-to-code  cmd="kiro agent implement"  pid=48213
17:44:10  info  ✓ done        rule=spec-to-code  pid=48213  exit=0  dur=103s
```

### 2. Log folder (structured JSONL)
- One JSON object per line (`.jsonl`), append-only, rotated by size.
- Machine-readable for shipping to log aggregators or post-hoc analysis.
- Location and rotation described below.

Example line:

```json
{"ts":"2026-09-14T15:44:10.221Z","level":"info","kind":"command.done","ruleId":"spec-to-code","eventId":"…","eventType":"element-description-changed","concurrencyKey":"element:9a1b…","pid":48213,"exitCode":0,"durationMs":103000}
```

Common `kind` values: `conn.state`, `event.received`, `event.skipped`, `rule.matched`,
`schedule.debounce`, `schedule.queue`, `command.start`, `command.done`, `command.error`,
`auth.refresh`, `shutdown`.

### 3. Per-command logs
Each spawned command's stdout+stderr is captured to its own file:

```
<logDir>/commands/<YYYYMMDD-HHMMSS>-<eventType>-<shortEventId>.log
```

This lets you read exactly what an agent printed for a given change, long after the run.

## Log directory layout

```
<logDir>/
  spec-stream.jsonl            # combined structured log (rotated)
  spec-stream.jsonl.1          # rotated older segment
  commands/
    20260914-174227-element-description-changed-9a1b2c.log
    …
```

`<logDir>` resolution and defaults are in [`paths.md`](./paths.md). Summary:

- Project mode (default): `./.spec-stream/logs/`.
- Daemon/user mode: `${XDG_STATE_HOME:-~/.local/state}/spec-stream/logs/`.
- Override with `logDir` in config or `--log-dir`.

## Rotation

- Size-based: when `spec-stream.jsonl` exceeds a threshold (default ~10 MB) it is rotated
  to `.1`, `.2`, … keeping a bounded number of segments (default 5).
- Per-command logs are not rotated (they are per-run and self-limiting); prune the
  `commands/` folder as needed.

Rotation is implemented with the Node standard library — no external logging dependency.

## Levels

| Level | Use |
|-------|-----|
| `trace` | Raw realtime payloads, scheduler internals. |
| `debug` | Command stdout/stderr mirrored to terminal, filter decisions. |
| `info` | Connections, events, runs, results (the default). |
| `warn` | Recoverable issues (reconnecting, refresh retry, dropped duplicate). |
| `error` | Command failures, auth failures, malformed events. |

Set via `logLevel` in config, or `--verbose` (⇒ `debug`) / `--quiet` (⇒ `warn`).

## Redaction

The API key (`pb_…`) and JWT tokens are **always** redacted in both sinks, at every
level. See [`authentication.md`](./authentication.md).

## Viewing logs

```
spec-stream logs           # print the combined log
spec-stream logs -f        # follow (tail -f) the combined log
```

In background mode, `logs` reads the same JSONL file the detached process writes to (see
[`background-mode.md`](./background-mode.md)).
