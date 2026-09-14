# Paths: config discovery, logs, and PID file

`spec-stream` follows common CLI conventions for where it finds config and where it puts
runtime state.

## Config discovery

On startup, `spec-stream` looks for its config file in this order:

1. `--config <path>` flag, if given (must exist, else fail-fast).
2. `proophboard.spec-stream.json` in the current working directory.
3. Walking **up** the directory tree from the CWD until one is found or the filesystem
   root is reached (cosmiconfig-style upward search). This lets you run `spec-stream`
   from any subfolder of your project.

If no config is found, `spec-stream` exits with a message explaining how to create one.

The directory that contains the resolved config file is the **config dir**, used as the
default base for `cwd` and project-mode logs.

## The API key (env, not files)

The API key is resolved separately and only from the environment:

1. `PROOPHBOARD_API_KEY` in `process.env`.
2. A `.env` file in the CWD (Node ≥ 20.6: run with `--env-file=.env`; older Node: the
   optional `dotenv` dependency).

It is never read from `proophboard.spec-stream.json`. See
[`authentication.md`](./authentication.md).

## Runtime state: logs and PID file

There are two modes, chosen automatically and overridable.

### Project mode (default)

When a config file is found in/under the CWD, runtime state lives **with the project**,
so logs sit next to the repository your agents operate on:

```
<config-dir>/.spec-stream/
  logs/
    spec-stream.jsonl
    commands/…
  spec-stream.pid
```

Rationale: the logs and the code the agents change are in one place; easy to inspect,
easy to `.gitignore` (the repo's `.gitignore` already ignores `logs`, `*.pid`, and
`.spec-stream/` should be added).

### Daemon / user mode

For a machine-wide daemon not tied to a single project, state follows the **XDG Base
Directory** spec:

```
${XDG_STATE_HOME:-~/.local/state}/spec-stream/
  logs/
    spec-stream.jsonl
    commands/…
  spec-stream.pid
```

On Windows the equivalent is `%LOCALAPPDATA%\spec-stream\`.

### Choosing / overriding

- `logDir` in config or `--log-dir <path>` overrides the log location in either mode.
- `--state-dir <path>` (or config `stateDir`) overrides where the PID file lives.
- Directories are created on demand with restrictive permissions.

## PID file

- Contains the process id of the running instance (one per state dir).
- Written on `start` (background) or on `run` when `--detach` is used.
- Read by `stop`/`status`/`logs`.
- Stale-PID detection: if the PID file exists but no such process is running,
  `spec-stream` treats it as not running and cleans it up. See
  [`background-mode.md`](./background-mode.md).

## Summary table

| Item | Project mode | Daemon/user mode | Override |
|------|--------------|------------------|----------|
| Config | `proophboard.spec-stream.json` (CWD up to root) | same | `--config` |
| API key | `PROOPHBOARD_API_KEY` / `.env` | same | env only |
| Logs | `<config-dir>/.spec-stream/logs/` | `${XDG_STATE_HOME:-~/.local/state}/spec-stream/logs/` | `logDir` / `--log-dir` |
| PID | `<config-dir>/.spec-stream/spec-stream.pid` | `${XDG_STATE_HOME:-~/.local/state}/spec-stream/spec-stream.pid` | `--state-dir` |
