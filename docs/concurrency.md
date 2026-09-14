# Concurrency: queue, debounce, dedupe, batch

This is the heart of `spec-stream`'s behavior and the answer to the motivating problem:

> A user edits a sticky note's description → an agent starts working. The user edits the
> **same** note again while the agent is still running. We must not start a **second**
> agent on the same task. But an edit to an **unrelated** element should be free to run
> its own agent in parallel.

The Scheduler is the single component that decides *when* a matched task runs. Every
decision is based on two things: the task's **concurrency key** and the rule's **mode**.

## Concurrency keys — "lanes"

A key groups tasks into a lane. **Same key ⇒ coordinated** (serialized/coalesced).
**Different keys ⇒ independent** (run in parallel, subject to global limits).

Configured via `concurrency.key`:

| `key` | Derivation | Effect |
|-------|-----------|--------|
| `element` | `elementId` | Edits to the *same* element are coordinated; different elements run in parallel. **Default for element events.** |
| `slice` | `sliceId` | Coordinate per slice. |
| `chapter` | `chapterId` | Coordinate per chapter. |
| `global` | constant | Everything in this rule is one lane (fully serialized). |
| `<template>` | string with `$SPEC_STREAM_*` | Custom, e.g. `"$SPEC_STREAM_CHAPTER_ID:$SPEC_STREAM_ELEMENT_TYPE"`. |

Keys are also namespaced per rule, so two different rules never accidentally share a lane
unless you use identical `global`/template keys on purpose.

## Modes — behavior *within* a key

Configured via `concurrency.mode`:

### `parallel`
Run immediately, no coordination (still bounded by `maxConcurrent` and `max`). Use for
independent, idempotent side effects (notifications, metrics).

```
e1 ─▶ run
e2 ─▶ run   (concurrently)
```

### `queue` (default)
One run at a time per key; further matches wait FIFO and each runs in turn.

```
e1 ─▶ run ───────▶ done
e2 ─────(wait)────────────▶ run ──▶ done
```

Use when every event must be processed but not simultaneously for the same key.

### `debounce`
Wait for `wait` ms of quiet after the **last** matching event, then run **once** with the
latest event. Bursts collapse into a single run.

```
e1 e2 e3  ...(quiet for `wait`)...  ─▶ run once (with e3)
```

**Recommended for description/details edits**: a user typing and saving repeatedly
produces one agent run, not one per keystroke-save.

### `dedupe`
While a command for this key is running, drop further matches (or keep only the last,
see below). Prevents piling up duplicate work.

```
e1 ─▶ run ───────────▶ done
e2 (while running) ─▶ dropped
```

### `batch`
Collect matching events for `wait` ms (or until `maxBatch` reached), then run **once**
with the whole batch on stdin (`mode: "batch"`, see
[`command-context.md`](./command-context.md)).

```
e1 e2 e3  ...(wait window)...  ─▶ run once (with [e1,e2,e3])
```

Use for "N related changes → one agent pass" (e.g. regenerate docs after a burst of
structural edits).

## Solving the motivating scenario

The robust configuration combines **debounce** (collapse rapid edits) with **per-key
serialization** so a late edit that arrives *after* the agent already started does not
spawn a competitor:

```jsonc
{
  "on": "element-description-changed",
  "run": "kiro agent implement",
  "concurrency": {
    "key": "element",     // same note = same lane; other notes run in parallel
    "mode": "debounce",   // rapid re-saves collapse into one run
    "wait": 8000,
    "max": 1              // at most one agent per element at a time
  }
}
```

Timeline:

```
t=0    user saves note A          ─▶ debounce timer starts (8s)
t=3s   user saves note A again    ─▶ timer resets
t=11s  quiet                      ─▶ run agent for A (key = A)
t=12s  user saves note A again    ─▶ new debounce; because max=1 and A is running,
                                     the new run is held until the current finishes
t=12s  user saves note B          ─▶ different key (B) → runs in parallel immediately
```

Note A is never worked on by two agents at once; Note B is unaffected.

### keep-last semantics

For `debounce`/`dedupe`, when a new matching event arrives while a run for the key is
in flight, the default is **keep-last**: remember the latest event and run it once when
the current run finishes (so the most recent spec is what gets implemented). Set
`mode: "dedupe"` with drop semantics if you'd rather ignore anything that arrives during
a run.

## Global limits

- `maxConcurrent` (top-level): hard cap on total simultaneously running commands. When
  reached, ready tasks wait regardless of key/mode.
- `concurrency.max` (per rule): cap within the rule/lane. Default `1` (except `parallel`).

## Interaction with shutdown

On graceful shutdown, queued/debounced/batched tasks that have **not** started are
discarded; **running** commands are given `drainTimeout` ms to finish
(see [`background-mode.md`](./background-mode.md)).

## Choosing a mode (rule of thumb)

| Goal | Mode | Key |
|------|------|-----|
| Implement a spec as it's edited | `debounce` | `element` |
| Process every structural change once, in order | `queue` | `chapter` |
| Fire-and-forget notification | `parallel` | `global` |
| Avoid duplicate long jobs | `dedupe` | `element`/`slice` |
| Coalesce a burst into one pass | `batch` | `chapter` |
