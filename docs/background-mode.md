# Background Mode & Process Lifecycle

`spec-stream` runs in the **foreground** by default (like `tail -f`) and can also run
detached in the **background** as a user daemon. Both are the same program; background
mode adds a PID file and detached I/O.

## Subcommands

| Command | Description |
|---------|-------------|
| `spec-stream` / `spec-stream run` | Run in the foreground. Ctrl-C (SIGINT) stops it gracefully. |
| `spec-stream run --detach` | Start in the background and return to the shell. |
| `spec-stream start` | Start in the background (alias for `run --detach`). |
| `spec-stream stop` | Stop the background process gracefully. |
| `spec-stream status` | Report whether it's running + connection/health info. |
| `spec-stream logs [-f]` | Print / follow the combined log. |

## Foreground mode

- Owns the terminal; logs stream to stdout/stderr (colorized on a TTY).
- `SIGINT` (Ctrl-C) / `SIGTERM` triggers **graceful shutdown**.
- No PID file is written (there's nothing to manage externally) unless `--detach` is used.

## Background (detached) mode

Implemented with the Node standard library — no process-manager dependency:

1. The foreground invocation re-spawns itself with `child_process.spawn` using:
   - `detached: true` (new session/process group so it survives the parent),
   - `stdio: ['ignore', logFd, logFd]` where `logFd` is an open handle to the combined
     log file (so output is not tied to the terminal),
   - then `child.unref()` so the parent can exit.
2. The child writes its PID to the PID file (see [`paths.md`](./paths.md)).
3. The parent prints the PID + log location and exits `0`.

```
$ spec-stream start
spec-stream started (pid 48213)
logs: ./.spec-stream/logs/spec-stream.jsonl
$ _            # shell is free; spec-stream keeps running
```

## PID file & single-instance

- One PID file per state dir. `start` refuses to launch a second instance if a live PID
  is found, printing the existing PID.
- **Stale PID handling:** if the PID file exists but the process is gone (checked via
  `process.kill(pid, 0)`), it is considered not running and the stale file is removed
  before starting.

## `stop` and graceful shutdown

`stop` reads the PID and sends `SIGTERM`. On `SIGTERM`/`SIGINT` the process:

1. Stops accepting new events (unsubscribes from the channel).
2. Cancels queued/debounced/batched tasks that haven't started.
3. Waits up to `drainTimeout` ms (config, default 30 000) for **running** commands to
   finish.
4. Force-kills anything still running past the timeout.
5. Removes the PID file and exits `0`.

```
$ spec-stream stop
stopping spec-stream (pid 48213)… draining 1 running command…
stopped
```

If the process doesn't exit within a grace period, `stop` escalates to `SIGKILL`.

## `status`

```
$ spec-stream status
spec-stream: running (pid 48213), uptime 2h13m
  connection : joined (workspace 8f3c…)
  transport  : realtime
  events     : 142 received, last 3m ago
  commands   : 37 run, 2 failed, 1 running
  backoff    : idle
  logs       : ./.spec-stream/logs/spec-stream.jsonl
```

When not running, `status` says so and exits non-zero (useful in scripts/monitoring).

## `logs`

- `spec-stream logs` prints the combined JSONL log (optionally pretty-printed).
- `spec-stream logs -f` follows it (`tail -f`-style), for watching a background instance.

## Running under a real service manager

Background mode is convenient for local/dev use. For servers, running `spec-stream` (in
**foreground**) under a supervisor is recommended and plays nicely with the graceful
shutdown semantics:

- **systemd** (user or system service): `ExecStart=spec-stream run`, `Restart=always`,
  `KillSignal=SIGTERM`, `TimeoutStopSec` ≥ `drainTimeout`.
- **Docker**: `CMD ["spec-stream", "run"]`; the process is PID 1-friendly and handles
  `SIGTERM`.
- **launchd / Windows services**: run the foreground command; the manager handles
  restarts and logging.

Under a service manager you generally do **not** use `start`/`stop`/PID files — let the
manager own the lifecycle and let `spec-stream` log to stdout (captured by the manager).
