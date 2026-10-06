# scenario — run Exploration Mode scenarios from the local model

The `scenario` subcommands let you typecheck, execute, and test
[Exploration Mode](https://flow.prooph-board.com/docs/exploration-mode) scenarios
directly from your local file tree — without opening a browser or calling the
prooph board API.

Everything reads from the `.spec-stream/model/` directory that
`spec-stream run` keeps in sync. Nothing is written back to the board.

## Prerequisites

Local model sync must be enabled in your `proophboard.spec-stream.json`:

```json
{
  "localSync": { "enabled": true, "dir": ".spec-stream/model" }
}
```

Then populate the model by running `spec-stream run` (or `spec-stream start`
for background mode) at least once before using the `scenario` commands.

---

## Commands

### `scenario typecheck`

Validate the TypeScript in `play-function.ts` and `play-type.ts` files against
the model-derived types for the chapter — the same type surface the prooph board
editor uses.

```
@proophboard/spec-stream scenario typecheck [--chapter <id|path>]
```

- **Without `--chapter`**: typechecks every chapter in the model.
- **With `--chapter`**: typechecks only the specified chapter.

**What it catches:**
- Typo'd event or command names that don't exist in the model
- Wrong property access on a declared `play-type`
- Syntax errors in a `play-function.ts`
- A `play-type.ts` that isn't a valid TypeScript type expression

**Exit codes:** `0` = no errors, `1` = one or more type errors found.

**Example output (errors):**
```
Add Todo (el-cmd-1a2b):
  [play-function] 3:5  TS2345: Argument of type '"TodoAdded"' is not assignable
                        to parameter of type 'EventName'.

1 error(s) found.
```

**Example output (clean):**
```
✓ No type errors found.
```

---

### `scenario run`

Execute a scenario through all its authored play functions and print what
happened: which events were emitted, what the final projection state looks like,
derived read views, and any runtime errors.

```
@proophboard/spec-stream scenario run --chapter <id|path> --scenario <id|name> [--playhead <n>]
```

**Options:**

| Option | Description |
|---|---|
| `--chapter <id\|path>` | Chapter UUID, or path to the chapter directory |
| `--scenario <id\|name>` | Scenario UUID or name (case-insensitive) |
| `--playhead <n>` | Stop the fold at step `n` instead of the final step |

**Example:**
```
@proophboard/spec-stream scenario run \
  --chapter abc123 \
  --scenario "Happy Path"
```

**Example output:**
```
── Scenario: Happy Path ──
Clock: 2024-01-01T00:00:00.000Z

Events (2):
  [App] Todo Added
    {"name":"Buy milk"}
  [App] Todo Added
    {"name":"Walk the dog"}

Read views (1):
  App.Todo List: [{"name":"Buy milk"},{"name":"Walk the dog"}]
```

Exit code is always `0` — `run` is informational, not a pass/fail gate.

---

### `scenario test`

Run one or all scenarios in a chapter against their pinned expectations and
report pass / broken / neutral verdicts. Exits non-zero if any scenario is broken.

```
@proophboard/spec-stream scenario test --chapter <id|path> (--scenario <id|name> | --all)
```

**Options:**

| Option | Description |
|---|---|
| `--chapter <id\|path>` | Chapter UUID, or path to the chapter directory |
| `--scenario <id\|name>` | Run a specific scenario |
| `--all` | Run every scenario in the chapter |

**Verdicts:**

| Verdict | Meaning |
|---|---|
| `pass` ✓ | All pinned expectations matched |
| `broken` ✗ | One or more pinned expectations failed |
| `neutral` ○ | Scenario has no pinned expectations — nothing to assert |

**Exit codes:** `0` = all pass or neutral, `1` = at least one broken.

**Example:**
```
@proophboard/spec-stream scenario test --chapter abc123 --all
```

**Example output:**
```
  ✓ Happy Path  [pass]
  ✗ Error Case  [broken]
      events on slice slice-xyz: mismatch — expected 1 event, got 0
  ○ Scratch     [neutral]

1 passed, 1 broken, 1 neutral
```

---

## Identifying chapters and scenarios

For `--chapter` and `--scenario` you can use:

- **UUID** — the `id` from the prooph board model (visible in `chapter.json`,
  `scenario.json`, or `uuid-index.json` at the model root).
- **Name / label** — the human-readable name. Matching is case-insensitive for
  scenarios.
- **Path** — an absolute or relative path to the chapter directory on disk
  (e.g. `.spec-stream/model/chapters/App/abc123_Todo-App`).

---

## Typical workflow with an AI agent

```
# 1. Sync the board model to disk (keep running in background)
@proophboard/spec-stream start

# 2. Agent edits a play function locally
# .spec-stream/model/chapters/App/.../elements/.../play-function.ts

# 3. Catch type errors before running anything
@proophboard/spec-stream scenario typecheck --chapter <id>

# 4. Confirm expectations still hold
@proophboard/spec-stream scenario test --chapter <id> --all

# 5. Commit and push the change back to the board
git add .spec-stream/model
@proophboard/spec-stream sync-back # or configure as pre-commit hook
git commit -m "fix: update Add Todo handler"
```

---

## Determinism and clocks

Scenarios with a `clock` field pinned (set in the prooph board Exploration Mode
scenario editor) produce deterministic results: `uuid()` and `now()` calls in
play functions return the same values on every run.

Scenarios without a pinned clock use the wall clock at execution time. Results
will differ between runs, so pinning expectations on such scenarios is not
recommended. The `run` command will show `Clock: (wall clock)` in the output as
a reminder.
