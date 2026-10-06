# spec-stream: scenario runner — implementation task list

Adds `spec-stream scenario {typecheck,run,test}` — three subcommands that let
agents validate, execute, and assert Exploration Mode scenarios directly from the
`.spec-stream/model/` file tree. No board API calls. No browser.

Reference: `docs/local-scenario-runner.md`.

---

## Prerequisites (already done)

- [x] `@proophboard/exploration-runtime` published — exports `foldChapter`,
  `runScenario`, `runAllScenarios`, `buildModelDts`, `buildPerElementDts`,
  `RUNTIME_AMBIENT_DTS`, `transpilePlayFunction`, `wrapPlayType`, `parsePlayType`,
  `toImplicitScenario`, and all needed types.
- [x] eventflow-designer: `runtimeSteps.ts` extracted; `runtimeFold` /
  `scenarioRunner` no longer import from the React hook — zero React in the
  runtime graph.

---

## Task 1 — Add dependencies

**File:** `package.json`

- Add `"@proophboard/exploration-runtime": "<published-version>"` to `dependencies`.
- `typescript` is already a `devDependency` — confirm it is present (needed for the
  in-memory `ts.Program` in the typecheck command).

No other new deps: sucrase is bundled inside the exploration-runtime package.

---

## Task 2 — `src/scenario/loadChapter.ts` (pure, no I/O dependency injection)

Reconstruct a `Chapter` (from `@proophboard/exploration-runtime`) from the on-disk
slice-first file tree. This is the loader the three subcommands all call first.

### 2.1 Interface

```ts
// Given the absolute path to a chapter directory (e.g.
// ".spec-stream/model/chapters/App/abc123_Todo"), reconstruct the Chapter.
export async function loadChapterFromDisk(chapterDir: string): Promise<Chapter>;

// Resolve a chapter directory from either:
//   - a UUID (looked up in uuid-index.json at the model root)
//   - an absolute or relative path already pointing at a chapter dir
export async function resolveChapterDir(
  modelRoot: string,
  idOrPath: string,
): Promise<string>;
```

### 2.2 Implementation

1. Read `chapter.json` → `{ id, name, context, mode, sliceOrder, laneOrder }`.
2. Glob `slices/*/slice.json`; for each, read and build a `Slice`. Sort by `index`.
3. Glob `slices/*/lanes/*/` for `lane.json`. De-duplicate lanes by `id` (each lane
   appears once per slice on disk — the loader takes the first occurrence for metadata,
   which is identical across copies). Build `Lane[]`.
4. Glob `slices/*/lanes/*/elements/*/element.json`; for each element:
   - Read `element.json` → base fields (`id, type, name, context, laneId, sliceId,
     index, icon, noArrowSource, noArrowTarget`).
   - If `playFunctionRef` is set, read the sibling `play-function.ts` → `element.playFunction`.
   - If `playTypeRef` is set, read the sibling `play-type.ts` (stored as
     `type Payload = <expr>`) and call `parsePlayType` to extract the bare expression
     → `element.playType`. (Store the bare expression, not the wrapped form, to match
     what the browser's `Element.playType` contains.)
5. Return `{ id, name, context, mode, slices, lanes, elements, index: 0 }`.

### 2.3 uuid-index resolution

`uuid-index.json` at the model root maps `uuid → relative/dir`. When `idOrPath` looks
like a UUID, read `uuid-index.json` and resolve from there.

### 2.4 Tests — `src/scenario/loadChapter.test.ts`

Fixture: a minimal in-memory `DesiredTree` (use `render()` from `src/sync/render.ts`
with a hand-built `ModelState`) written to a temp directory via `fs.mkdtemp`. Assert:
- Reconstructed `chapter.id`, `name`, `context`, `mode` match the source.
- All slices present with correct `index` ordering.
- All elements present, each with the correct `laneId` / `sliceId` / `index`.
- An element with `playFunctionRef` set has its `playFunction` populated.
- An element with `playTypeRef` set has its `playType` set to the **bare** expression
  (without the `type Payload =` wrapper).
- `resolveChapterDir` by UUID finds the right directory via `uuid-index.json`.

---

## Task 3 — `src/scenario/loadScenario.ts` (pure)

Read a `Scenario` (from `@proophboard/exploration-runtime`) from a `scenario.json` file.

### 3.1 Interface

```ts
// Load one scenario from its directory.
export async function loadScenarioFromDisk(scenarioDir: string): Promise<Scenario>;

// List all scenario directories for a chapter.
export async function listScenarioDirs(chapterDir: string): Promise<string[]>;

// Resolve a scenario directory from a chapter dir and a scenario id or name.
export async function resolveScenarioDir(
  chapterDir: string,
  idOrName: string,
): Promise<string>;
```

### 3.2 Implementation

- Read `scenario.json`; parse into `Scenario` (the shape matches the file exactly —
  `id, chapterId, name, clock?, initialState?, seededEvents[]?, interactions[]?,
  expectations[]?`).
- `listScenarioDirs`: glob `scenarios/*/scenario.json`, return the parent dirs.
- `resolveScenarioDir`: match by `scenario.json.id` or `scenario.json.name` (exact,
  then case-insensitive fallback). Error if zero or multiple matches.

### 3.3 Tests — `src/scenario/loadScenario.test.ts`

Fixture the same rendered temp dir from Task 2.
- Round-trip: `ModelState` scenario → rendered → loaded → fields match source.
- `expectations[]` array survives the round-trip (including `kind`, `sliceId`,
  `match`, and the `expected` payload).
- `listScenarioDirs` returns one entry per scenario.
- `resolveScenarioDir` by name (case-insensitive) finds the right one.

---

## Task 4 — `src/scenario/typecheck.ts` (pure)

Typecheck `play-function.ts` (and `play-type.ts`) for one element against the
model-derived TypeScript ambient surfaces.

### 4.1 Interface

```ts
export interface PlayFunctionDiagnostic {
  elementId: string;
  elementName: string;
  elementType: string;
  kind: "play-function" | "play-type";
  /** 1-based line number within the source file. */
  line: number;
  col: number;
  /** TypeScript error code (e.g. 2339). */
  code: number;
  message: string;
}

// Typecheck all elements with play-function.ts / play-type.ts in a chapter.
export async function typecheckChapter(
  chapter: Chapter,
): Promise<PlayFunctionDiagnostic[]>;

// Typecheck a single element.
export function typecheckElement(
  chapter: Chapter,
  element: Element,
): PlayFunctionDiagnostic[];
```

### 4.2 Mechanism

Use the TypeScript compiler API (`import * as ts from 'typescript'`):

1. Build the three dts strings:
   - `RUNTIME_AMBIENT_DTS` (static, same for every element)
   - `buildModelDts(chapter)` (per-chapter)
   - `buildPerElementDts(element)` (per-element)
2. Create an in-memory `ts.CompilerHost` with virtual files:
   - `exploration-runtime.d.ts` → ambient dts
   - `exploration-model.d.ts`   → model dts
   - `exploration-element.d.ts` → per-element dts
   - `handler.ts`               → element's `playFunction` source
3. Compiler options matching Monaco's settings:
   `{ target: ES2020, lib: ['es2020'], noEmit: true, allowNonTsExtensions: true,
      moduleResolution: NodeJs, strict: false, noImplicitAny: false }`.
4. Collect `getSyntacticDiagnostics('handler.ts')` +
   `getSemanticDiagnostics('handler.ts')`.
5. Map to `PlayFunctionDiagnostic[]`. Skip diagnostics on the dts virtual files
   (only report on `handler.ts`).

For `play-type.ts`: wrap the stored bare expression with `wrapPlayType` (produces
`type Payload = <expr>;`), typecheck as a standalone file, collect diagnostics.
Also call `parsePlayType(wrappedContent)` and surface a parse error if it returns
`ok: false`.

### 4.3 Tests — `src/scenario/typecheck.test.ts`

No filesystem needed; build a minimal `Chapter` + `Element` in memory.

- A valid `decide` function with typed payload → zero diagnostics.
- A function that accesses a non-existent property on a declared `playType` →
  diagnostic with `code: 2339` (property does not exist).
- A function that uses a typo'd event name (not in `EventName` union) → error.
- An empty `playFunction` → zero diagnostics (absent → permissive).
- A `play-type.ts` with valid `type Payload = { id: string }` → zero diagnostics.
- A `play-type.ts` missing the `type Payload =` wrapper → `parsePlayType` error
  surfaced as a diagnostic.

---

## Task 5 — `src/scenario/run.ts` — execute a scenario

Fold a scenario through all authored play functions to the final playhead. Returns
the `RuntimeResultV2` plus any transpile errors.

### 5.1 Interface

```ts
export interface ScenarioRunOutput {
  scenarioId: string;
  scenarioName: string;
  /** Events emitted (ordered, with payloads and timestamps). */
  events: RuntimeEvent[];
  /** Final projection state tree. */
  state: Record<string, unknown>;
  /** Information `read()` derived views at the final playhead. */
  readViews: RuntimeReadView[];
  /** Runtime errors (threw / rejected / cascade-exceeded), tagged by sliceId. */
  errors: RuntimeError[];
  /** Automation commands that never reached their target slice. */
  pendingCommands: PendingCommand[];
  clockISO: string;
}

export async function runScenarioFromDisk(
  chapter: Chapter,
  scenario: Scenario,
  /** Optional playhead index; defaults to final step. */
  playheadIndex?: number,
): Promise<ScenarioRunOutput>;
```

### 5.2 Implementation

1. Transpile handlers: for each `element` where `element.playFunction?.trim()` is
   non-empty, call `await transpilePlayFunction(element.playFunction)`. Collect
   transpile errors (failed elements fall back to defaults, matching `handlerWorker.ts`
   behaviour exactly).
2. Call `deriveRuntimeSteps(chapter)` to get step count.
3. Call `foldChapter(chapter, toImplicitScenario(scenario), playhead, handlers)`.
4. Merge transpile errors into `result.errors` (ahead of fold errors).
5. Return `ScenarioRunOutput`.

### 5.3 Tests — `src/scenario/run.test.ts`

Build a minimal `Chapter` (3 slices: UI → Write → Read) and `Scenario` in memory.

- No handlers (defaults only): verify events emitted and state matches the default
  behaviour (same assertions as `runtimeFold.test.ts`'s "defaults" cases).
- With an authored `decide` function: verify the event payload comes from the handler,
  not the default pass-through.
- A handler that throws: verify error recorded in `errors`, fold continues.
- `playheadIndex = 0`: verify only the first step's events appear.

---

## Task 6 — `src/scenario/test.ts` — run scenario expectations

Thin wrapper over `runScenario` / `runAllScenarios` from the runtime package. Returns
structured results and a boolean `hasBroken` flag for CLI exit code.

### 6.1 Interface

```ts
export interface ScenarioTestOutput {
  results: ScenarioRunResult[];
  /** true if any scenario has status 'broken'. */
  hasBroken: boolean;
  /** scenarios with no expectations (neutral) — surfaced as warnings. */
  neutralCount: number;
}

export async function testScenariosFromDisk(
  chapter: Chapter,
  scenarios: Scenario[],
): Promise<ScenarioTestOutput>;
```

### 6.2 Implementation

1. Transpile all handlers once (same as `run.ts` — extract a shared
   `transpileHandlers(chapter)` helper used by both).
2. Call `runAllScenarios(chapter, scenarios, handlers)`.
3. Derive `hasBroken` and `neutralCount` from the results.

### 6.3 Tests — `src/scenario/test.test.ts`

- All-pass scenario → `hasBroken: false`, `results[0].status === 'pass'`.
- One broken expectation (dangling-reference) → `hasBroken: true`.
- Zero expectations → `neutralCount: 1`, `hasBroken: false`.
- Multiple scenarios, mixed verdicts → correct rollup.

---

## Task 7 — Shared `transpileHandlers` helper

Extract the transpile-all-handlers loop into a small shared utility so `run.ts` and
`test.ts` don't duplicate it.

```ts
// src/scenario/transpile.ts
export async function transpileHandlers(
  chapter: Chapter,
): Promise<{ handlers: TranspiledHandlers; errors: RuntimeError[] }>;
```

Mirrors `handlerWorker.ts`'s `transpileHandlers` exactly: transpile errors are
recorded (handler falls back to default), never thrown.

---

## Task 8 — CLI wiring

### 8.1 Extend `CliOptions` and `parseArgs` in `src/cli/args.ts`

Add `"scenario"` to the `Subcommand` union. Add scenario-specific option fields:

```ts
// scenario subcommand fields
scenarioSubcommand?: "typecheck" | "run" | "test";
chapterRef?: string;   // --chapter <id|path>
scenarioRef?: string;  // --scenario <id|name>
all?: boolean;         // --all (test all scenarios in chapter)
playhead?: number;     // --playhead <n> (run only, optional)
```

Parsing: `scenario typecheck`, `scenario run`, `scenario test` are nested subcommands
(`argv[0] === 'scenario'`, `argv[1]` is the sub-subcommand). Parse `--chapter`,
`--scenario`, `--all`, `--playhead` when `command === 'scenario'`.

Update `HELP_TEXT` with the scenario section.

Update `src/cli/args.test.ts` with cases for the new flags.

### 8.2 `src/scenario/index.ts` — command entry point

```ts
export async function runScenarioCommand(opts: CliOptions, modelRoot: string): Promise<void>;
```

Dispatch on `opts.scenarioSubcommand`:

**`typecheck`:**
- Resolve chapter(s) from `--chapter` (or all chapters if absent).
- Call `loadChapterFromDisk`, then `typecheckChapter`.
- Print diagnostics grouped by element name. Zero diagnostics → print "✓ No type
  errors found." Exit 1 if any diagnostics, else 0.

**`run`:**
- Require `--chapter` and `--scenario`.
- Load chapter + scenario.
- Call `runScenarioFromDisk(chapter, scenario, opts.playhead)`.
- Print: emitted events as JSON-ish table, final state as YAML (re-use `js-yaml` —
  already available in the ecosystem; add it if not present), errors. Exit 0 always
  (execution is informational, not a pass/fail gate).

**`test`:**
- Require `--chapter`; `--scenario` or `--all`.
- Load chapter + scenario(s).
- Call `testScenariosFromDisk`.
- Print per-scenario verdict with per-expectation breakdown on failures.
- Summary line: "N passed, M broken, K neutral."
- Exit 1 if `hasBroken`, else 0.

### 8.3 Wire into `src/cli.ts` (or `src/app.ts`)

In the existing CLI dispatch, add a branch for `command === 'scenario'` that calls
`runScenarioCommand`. Detect `modelRoot` from the config's `localSync.dir` (or the
default `.spec-stream/model` relative to the config file).

---

## Task 9 — Guard: `localSync` must be enabled

Before any `scenario` subcommand proceeds, check that `localSync.enabled` is `true`
in the resolved config and that the model directory exists. If not, print a clear
actionable error:

```
Error: 'scenario' commands require localSync to be enabled.
Add to proophboard.spec-stream.json:
  { "localSync": { "enabled": true, "dir": ".spec-stream/model" } }
Then run: spec-stream run   (to populate the model)
```

---

## Task 10 — Integration smoke test (optional but recommended)

`src/scenario/integration.test.ts` — uses the todo-app fixture JSON already present
in `eventflow-designer/transformation/` (or a minimal inline fixture):

1. Build a `ModelState` + `DesiredTree` using `render()`.
2. Write to a real temp dir with `fs.mkdtemp`.
3. Call `loadChapterFromDisk` → `loadScenarioFromDisk` → `testScenariosFromDisk`.
4. Assert the verdict matches an expected result seeded into the `ModelState`.

This is the parity test that guards against drift between the package's logic and
whatever the browser runs.

---

## Source layout

```
src/scenario/
  loadChapter.ts        Task 2
  loadChapter.test.ts
  loadScenario.ts       Task 3
  loadScenario.test.ts
  transpile.ts          Task 7
  run.ts                Task 5
  run.test.ts
  test.ts               Task 6
  test.test.ts
  typecheck.ts          Task 4
  typecheck.test.ts
  index.ts              Task 8.2
  integration.test.ts   Task 10
```

CLI changes:
```
src/cli/args.ts          Task 8.1
src/cli.ts (or app.ts)   Task 8.3
```

Config guard:
```
src/scenario/index.ts    Task 9 (inline in the command entry point)
```
