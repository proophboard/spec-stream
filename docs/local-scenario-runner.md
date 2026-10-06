# Local Scenario Runner — concept (draft)

**Status: concept / spec. Not yet implemented.**

Let agents run Exploration Mode **scenarios** and **scenario tests** (scenarios with
pinned expectations) directly against the `.spec-stream/model/` file tree produced by
[local model sync](./local-sync.md) — without a browser, prooph board, or MCP round-trip.

Three capabilities, in increasing ambition:

1. **Typecheck** — validate `play-function.ts` / `play-type.ts` with the TypeScript
   compiler against the model-derived ambient types (catch typos, wrong property
   access, bad assignments) **before** executing anything.
2. **Execute** — fold a scenario through the authored play functions (the same runtime
   the browser uses) so an agent can test a modified or newly written handler/type.
3. **Assert** — run scenarios against their pinned `expectations[]` and report
   pass / broken / neutral, so an agent can confirm the model is still valid after a change.

---

## 1. Is it possible today? (feasibility)

**Mostly yes, logically — but not yet packaged for Node.** The runtime that the browser
uses is already designed to be pure and environment-independent. The blocker is a
packaging/import coupling, not a semantic one.

### What already works out of the box

| Piece | File (eventflow-designer) | Node-ready? |
|---|---|---|
| Scenario-as-test oracle | `src/lib/playFunction/scenarioRunner.ts` | logic pure |
| The fold (execute handlers) | `src/lib/playFunction/runtimeFold.ts` | logic pure |
| TS→JS transpile (type-erasure) | `src/lib/playFunction/transpile.ts` (sucrase, dynamic import) | **yes** |
| Handler compile + invoke | `src/lib/playFunction/sandbox.ts` (`new Function`) | **yes** |
| Deterministic clock / uuid | `src/lib/playFunction/clock.ts` | **yes** |
| Cascade budget | `src/lib/playFunction/cascadeBudget.ts` | **yes** |
| Model-derived `.d.ts` generator | `src/lib/playFunction/modelTypes.ts`, `ambientTypes.ts` | **yes** (pure string builders) |
| `playType` wrap/parse | `src/lib/playFunction/playType.ts` | **yes** |
| On-disk inputs | `.spec-stream/model/**` (`play-function.ts`, `play-type.ts`, `scenario.json`, `element.json`, …) | **yes — already synced** |

The design docs are explicit that this was the intent: `runtimeFold.ts` says it is
"deliberately NOT a hook and touches no DOM/worker API … usable both inside the Worker
and on the main-thread sync fast-path", and `scenarioRunner.ts` says it is "PURE and
framework-free (no DOM/worker), so it is fully unit-testable." The Web Worker
(`handlerWorker.ts`) is only an **isolation wrapper** (so a runaway handler can be
`terminate()`-d); it holds no business logic and is not required for correctness.

### The one real blocker: a React import leak

Both `runtimeFold.ts` and `scenarioRunner.ts` import four **pure** helpers —
`deriveRuntimeSteps`, `seedState`, `mergeProjection`, `defaultDecide` — from
`src/hooks/useExplorationRuntime.ts`. That hook file is itself React-coupled at the top:

```ts
import { useEffect, useMemo, useRef, useState } from 'react';
import { useHandlerWorker } from '@/hooks/useHandlerWorker';
```

So importing the "pure" fold transitively drags React + a worker hook into the module
graph. In the browser that is fine; in a Node CLI it means the runtime can't be imported
without pulling in (and resolving the `@/` alias to) a React UI tree.

**The functions themselves are pure** (verified: `deriveRuntimeSteps`, `seedState`,
`mergeProjection`, `defaultDecide` read no React, no DOM). They just live in the wrong
file. This is a mechanical extraction, not a rewrite.

### Do we need to change the stored files? — No.

The local-sync tree already persists everything a run needs:

- `play-function.ts` and `play-type.ts` per element (written by `element-config-changed` /
  `element-config-synced`).
- `element.json` (`id, type, name, context, laneId, sliceId, index`, refs).
- `slice.json`, `lane.json`, `chapter.json` (`sliceOrder[]`, `laneOrder[]`, `mode`).
- `scenario.json` carrying `clock?`, `initialState?`, `seededEvents[]?`, `interactions[]?`,
  and crucially `expectations[]?`.

No new on-disk fields are required. The only work is **assembling** the normalized
`Chapter` object the runtime expects from the slice-first directory layout (and a small
decision about where the generated `.d.ts` and transpile cache live — see §6).

> One optional convenience (not required): emit a generated, per-chapter
> `.spec-stream/model/chapters/[Ctx]/[Chapter]/play-types.d.ts` during sync so the
> files are directly openable/typecheckable by an agent's editor without the runner
> regenerating them. See §4.3.

---

## 2. Shape of the solution

A new subcommand in spec-stream:

```
spec-stream scenario typecheck [--chapter <id|path>] [--element <id>]
spec-stream scenario run       [--chapter <id|path>] [--scenario <id|name>]
spec-stream scenario test      [--chapter <id|path>] [--scenario <id|name>] [--all]
```

- `typecheck` → capability (1): TS diagnostics only, no execution.
- `run` → capability (2): fold to the final playhead, print emitted events, final state,
  read views, and any runtime errors (threw / rejected / cascade-exceeded).
- `test` → capability (3): `runScenario` / `runAllScenarios`, print per-expectation
  verdicts and the overall `pass | broken | neutral`. Exit non-zero on `broken` so it
  slots into CI / pre-commit / an agent's verification loop.

All three read **only** from `.spec-stream/model/`. None call the board API.

### Why this belongs in spec-stream (not a new tool)

spec-stream already owns the file tree, already ships `typescript` as a dep, is a Node
`type: module` package with vitest, and already has the sync-back notion of "agent edits
files, we act on them." The scenario runner is the natural read-side counterpart to
sync-back's write side: *edit `play-function.ts` locally → typecheck/run/test locally →
commit → sync-back pushes it to the board.*

---

## 3. Portability refactor (eventflow-designer side)

The goal: make `scenarioRunner` + `runtimeFold` importable from a plain Node process
with **zero React in the graph**, without changing their behaviour (the browser must
keep passing its existing tests).

### 3.1 Extract the pure helpers

Create `src/lib/playFunction/runtimeSteps.ts` (name TBD) and **move** these from
`useExplorationRuntime.ts`:

- `RuntimeStep` (interface)
- `deriveRuntimeSteps`
- `seedState`
- `mergeProjection`
- `defaultDecide`
- (plus the tiny `clone` / `isPlainObject` helpers they rely on, or import a shared util)

`useExplorationRuntime.ts` then **re-exports** them (`export { deriveRuntimeSteps } from
'./runtimeSteps'`) so nothing else in the app changes its import path. `runtimeFold.ts`
and `scenarioRunner.ts` switch their import to the new pure module. Result: the runtime
module graph no longer touches `react` or `useHandlerWorker`.

Everything else they import is already pure:
- `@/types/eventModel`, `@/types/exploration` — type-only.
- `@/lib/toClassName` — pure string util.
- `@/utils/connectionRules` (`getConnections`, `getCommandsDrivenByUi`) — verified: no
  React/DOM imports.

### 3.2 Package the runtime for Node consumption

Two viable options:

- **(A) Publish a tiny internal package** `@proophboard/exploration-runtime` from
  eventflow-designer that exports `runScenario`, `runAllScenarios`, `foldChapter`,
  `buildModelDts`, `buildPerElementDts`, `RUNTIME_AMBIENT_DTS`, `wrapPlayType`,
  `parsePlayType`, and the relevant types. spec-stream depends on it. **Preferred** —
  single source of truth, versioned, no code duplication, the browser and the CLI run
  byte-identical logic.
- **(B) Vendor** the handful of pure files into spec-stream. Faster to bootstrap, but
  invites drift; only acceptable as a stopgap.

Either way the files involved are small and already dependency-light. The `@/` path
alias must resolve (A solves it via a real package; B via copying + fixing imports).

### 3.3 Transpiler note

`transpile.ts` lazy-imports `sucrase`. In the browser that keeps it out of the default
chunk; in Node it is just a dependency. spec-stream (or the extracted package) must add
`sucrase` to `dependencies`. `new Function` in `sandbox.ts` works in Node directly.

### 3.4 Isolation (worker) — optional for v1

The browser uses a Web Worker so a looping handler can be killed. In Node the equivalent
is a `worker_threads` Worker or a child process with a timeout; the cascade budget
(`cascadeBudget.ts`) already bounds total events/depth, which covers the common runaway
case synchronously. **v1 can run the fold in-process** behind the cascade budget and a
wall-clock watchdog; a `worker_threads` isolation wrapper can be added later mirroring
`handlerWorker.ts` if untrusted-handler isolation becomes a requirement. (Handlers here
are authored by the same team editing the repo, so the threat model is weaker than a
hosted multi-tenant board.)

---

## 4. Capability 1 — Typecheck play functions

### 4.1 What we're checking

The browser gives Monaco three layered `.d.ts` surfaces (`monacoPlayLibs.ts`):

1. `RUNTIME_AMBIENT_DTS` (`ambientTypes.ts`) — the static runtime surface
   (`RuntimeState`, `RuntimeEvent`, `uuid()`, `now()`, `reject()`, handler signatures `read`/`react`/`process`).
2. `buildModelDts(chapter)` (`modelTypes.ts`) — the per-chapter model surface:
   `CommandName` / `EventName` / `ContextName` literal unions, `CommandPayloads` /
   `EventPayloads` / `UiInputs` keyed by element name, `ProjectionPatch`, and the
   `RuntimeState` projection augmentation + `namespace RuntimeState`.
3. `buildPerElementDts(element)` (`modelTypes.ts`) — the per-element pinned
   `interact` / `decide` / `apply` whose first parameter is this element's declared type.

To typecheck **outside Monaco**, feed the same three `.d.ts` strings plus the handler
source to the **TypeScript compiler API** (`typescript` — already a spec-stream dep).

### 4.2 Mechanism

For each element with a `play-function.ts` (and/or `play-type.ts`):

1. Rebuild the chapter object (§5) and call `buildModelDts(chapter)` +
   `buildPerElementDts(element)` + the static `RUNTIME_AMBIENT_DTS`.
2. Create an **in-memory `ts.Program`** via a custom `CompilerHost` whose virtual files are:
   - `exploration-runtime.d.ts`  = `RUNTIME_AMBIENT_DTS`
   - `exploration-model.d.ts`    = `buildModelDts(chapter)`
   - `exploration-element.d.ts`  = `buildPerElementDts(element)`
   - `handler.ts`                = the `play-function.ts` content, wrapped so the handler
     body sees the ambient globals (the editor type-checks it as a global-scope script;
     mirror that — `allowNonTsExtensions`, `lib: ['es2020']`, `noEmit`, `target ES2020`,
     exactly as `ensurePlayLibs` sets).
   - For `play-type.ts`: `wrapPlayType` already produces a standalone `type Payload = …`;
     typecheck that buffer the same way the Type editor does, then `parsePlayType` to
     confirm it extracts cleanly.
3. Collect `getSemanticDiagnostics()` + `getSyntacticDiagnostics()`; map each to
   `{ elementId, elementName, file, line, col, code, message }`.

Because the generated model dts uses **strict literal unions** for names (an unknown
`CommandName` is an error, by design — see `modelTypes.ts` `nameUnion`), this catches
exactly the class of mistakes the user asked about: typo'd command/event/context names,
wrong property access on a declared `playType`, bad assignment to a projection patch.

### 4.3 Optional: emit the `.d.ts` into the tree during sync

So an agent's own editor/LSP sees the same types when it opens `play-function.ts`, the
**projection** could additionally write (during local-sync render):

```
chapters/[Ctx]/[Chapter]/
  _types/
    exploration-runtime.d.ts      # static (same for every chapter — or workspace-level)
    exploration-model.d.ts        # buildModelDts(chapter)
  slices/.../elements/[..]/
    play-function.ts              # could carry a /// <reference path="../../../_types/..."> header
    exploration-element.d.ts      # buildPerElementDts(element)  (optional, per element)
```

This is a **nice-to-have** that makes the files self-describing to any TS tool, not just
our runner. It is additive to the local-sync spec (a new render output; purely generated,
never synced back). If we skip it, the runner regenerates the dts in memory on demand —
no on-disk change needed. Recommend: start **without** it (runner-only), add it later if
agents want editor-native diagnostics.

---

## 5. Rebuilding the `Chapter` from the file tree

Both the fold and the dts builders take a normalized `Chapter`:

```ts
interface Chapter { id; name; context; mode; slices: Slice[]; elements: Element[]; … }
interface Element { id; type; name; context; laneId; sliceId; index; playFunction?; playType?; … }
```

The slice-first layout stores this **denormalized across directories**, so the runner
needs a small **loader** (pure, unit-testable) that walks one chapter directory and
reassembles it:

```
loadChapterFromDisk(chapterDir) -> Chapter
```

Steps:
1. Read `chapter.json` → `id, name, context, mode, sliceOrder[], laneOrder[]`.
2. For each `slices/[i]_[label]/slice.json` → a `Slice` (ordered by `index`).
3. Walk `slices/*/lanes/*/*/elements/*/element.json` → `Element[]`, attaching:
   - `playFunction` = contents of sibling `play-function.ts` (if present / `playFunctionRef`).
   - `playType`     = contents of sibling `play-type.ts` (if present / `playTypeRef`).
   - `description`  = `description.md`; `details` = `details.md` (not needed for the fold,
     but cheap to attach).
4. Resolve the `TranspiledHandlers`-feeding map: the fold wants `handlers: { [elementId]:
   source }` (the **TypeScript** source — the worker transpiles; our Node runner calls
   `transpilePlayFunction` the same way). So we pass `element.playFunction` through
   `transpilePlayFunction` (sucrase) before `foldChapter`, exactly as `handlerWorker.ts`
   does in `transpileHandlers`.

> Note: lanes are rendered **once per slice** on disk (local-sync's lane-per-slice
> rule). The loader must de-duplicate lanes by `lane.json.id` so the reconstructed
> `Chapter.elements[]` has each element exactly once (elements live under a specific
> `slice × lane`, so they are naturally unique; only lane metadata is duplicated).

`uuid-index.json` lets `--chapter <id>` / `--element <id>` resolve a UUID to a directory
in O(1) without a tree walk.

---

## 6. Capability 2 — Execute a scenario

Given the reconstructed `Chapter` and a parsed `scenario.json`:

```ts
import { transpilePlayFunction } from '…/transpile';
import { foldChapter } from '…/runtimeFold';
import { toImplicitScenario } from '…/types/exploration';

const handlers: Record<string,string> = {};              // elementId → TS source
for (const el of chapter.elements)
  if (el.playFunction?.trim()) handlers[el.id] = await transpilePlayFunction(el.playFunction);

const steps     = deriveRuntimeSteps(chapter);
const playhead  = steps.length - 1;                        // final playhead
const result    = foldChapter(chapter, toImplicitScenario(scenario), playhead, handlers,
                              undefined, undefined, 'PlayWorker');
```

Output for an agent: `result.events` (emitted event log with payloads/timestamps),
`result.state` (final projections), `result.readViews` (Information `read` outputs),
`result.errors` (threw / rejected / cascade-exceeded, each tagged with `sliceId` /
`elementId`), and `result.pendingCommands`. A transpile failure for one handler is
recorded as an error and that element falls back to its default — identical to
`handlerWorker.ts`.

A `--playhead <n>` flag lets an agent inspect an intermediate step; default is the end.

This is exactly what the user wants: **"execute play functions against recorded
scenarios so agents can test modified or newly written functions/types."** The recorded
`interactions[]` in `scenario.json` drive the UI steps with no human input (same as the
browser's recorded replay).

---

## 7. Capability 3 — Run scenario tests (expectations)

This is the thinnest layer — `scenarioRunner.ts` already implements the entire oracle:

```ts
import { runScenario, runAllScenarios } from '…/scenarioRunner';

const result = runScenario(chapter, scenario, transpiledHandlers);
//  result.status            : 'pass' | 'broken' | 'neutral'
//  result.expectationResults: per-pin verdict (events | information | rejection)
//  result.structuralErrors  : threw / cascade at non-pinned slices (repair context)
```

- **pass** — ≥1 expectation, all matched.
- **broken** — ≥1 expectation, ≥1 failed (mismatch, dangling-reference, threw,
  cascade-exceeded, rejected-missing, unexpected-events).
- **neutral** — zero expectations (nothing asserted — surface as a warning, not a failure).

`spec-stream scenario test --all` maps to `runAllScenarios` across every scenario in a
chapter (or the whole workspace). Verdict rollup → process exit code:
`broken` ⇒ exit 1 (fails CI / pre-commit / an agent's self-check); `pass`/`neutral` ⇒ 0.

The expectation resolution is **by stable `sliceId` / `elementId`** (never step index),
so a scenario test correctly reports **"the model moved under the test"** as a
`dangling-reference` broken verdict — precisely the "validate the model is still valid
after a change" signal the user asked for. After an agent edits a `play-function.ts` or
`play-type.ts` locally, `scenario test` tells it immediately whether the pins still hold.

### Pairing with sync-back

The round-trip the user is after:

```
spec-stream run        (board → files, live)
   edit play-function.ts / play-type.ts locally
spec-stream scenario typecheck   # catch type errors
spec-stream scenario test --all  # confirm expectations still hold
   git add .spec-stream/model/  →  pre-commit hook  →  spec-stream sync-back   (files → board)
```

sync-back already syncs `play-function.ts` / `play-type.ts` changes (via
`element-config` update) and `scenario.json` `expectations[]` changes. The scenario
runner is the **local verification gate** that makes editing-via-files safe: an agent can
prove its change before pushing it to the board.

---

## 8. Determinism parity (must-verify)

For local results to match the browser the clock/uuid substrate must be identical:

- `DeterministicClock(scenario.clock)` drives `now()`/`today()`; `uuid()` is clock+counter
  (`clock.ts`). This is pure JS and runs identically in Node — **but** confirm `clock.ts`
  does not read `Date.now()` for the base when `scenario.clock` is absent. If it falls
  back to wall-clock, a scenario **without a pinned `clock`** is non-deterministic in both
  environments; recommend the runner **warns** when a scenario under test has no `clock`
  (and `scenario.json` should carry one for any scenario with expectations).
- `transpile.ts` uses sucrase in both environments → identical type-erasure.
- `toClassName` is the shared util (design §4 flags the `startCase`/`upperFirst`
  divergence — ensure the extracted package uses the exact same implementation the
  board ships, since projection **keys** depend on it).

---

## 9. Testing strategy

- **Loader** (`loadChapterFromDisk`): fixture a small `.spec-stream/model/` tree, assert
  the reconstructed `Chapter` deep-equals the one the board would export. Reuse the
  todo example from `specs/exploration-mode/`.
- **Parity**: pick an existing `scenarioRunner.test.ts` case; run it (a) in the current
  browser/jsdom test and (b) through the new Node path from a rendered file tree; assert
  identical `ScenarioRunResult`. This guards the extraction refactor against drift.
- **Typecheck**: fixtures with a deliberate typo (`EventName` mismatch), a wrong property
  on a declared `playType`, and a clean handler; assert diagnostics (count + codes).
- **Exit codes**: `broken` ⇒ 1, `pass`/`neutral` ⇒ 0.

---

## 10. Summary of required changes

**eventflow-designer** (behaviour-preserving refactor):
1. Extract `deriveRuntimeSteps` / `seedState` / `mergeProjection` / `defaultDecide` /
   `RuntimeStep` into a React-free `runtimeSteps.ts`; re-export from
   `useExplorationRuntime.ts`.
2. Repoint `runtimeFold.ts` + `scenarioRunner.ts` imports to it.
3. (Preferred) publish `@proophboard/exploration-runtime` exporting the runtime +
   dts builders + types; or mark the pure files for vendoring.

**spec-stream** (new feature):
4. Add `sucrase` (and the exploration-runtime package) to `dependencies`.
5. `src/scenario/loadChapter.ts` — reconstruct `Chapter` from the file tree (pure).
6. `src/scenario/typecheck.ts` — in-memory `ts.Program` over the 3 dts + handler.
7. `src/scenario/run.ts` / `test.ts` — thin wrappers over `foldChapter` /
   `runScenario` / `runAllScenarios`, with reporting + exit codes.
8. `spec-stream scenario {typecheck,run,test}` CLI wiring.
9. (Optional, later) emit generated `_types/*.d.ts` into the tree during local-sync so
   agent editors get native diagnostics.

**Stored files:** no required changes. `play-function.ts`, `play-type.ts`,
`scenario.json` (incl. `expectations[]`), and the entity JSONs already carry everything.
The only optional additive output is the generated `_types/*.d.ts` (§4.3).
