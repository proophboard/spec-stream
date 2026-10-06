/**
 * Execute an Exploration Mode scenario through the authored play functions.
 *
 * Folds the scenario from step 0 to the final playhead (or a specified step),
 * then returns the emitted events, final state, read views, and any errors.
 * This mirrors what the browser's handlerWorker.ts does, but runs in-process
 * (no Web Worker isolation) — the cascade budget bounds runaway handlers.
 */

import type {
  Chapter,
  Scenario,
  RuntimeEvent,
  RuntimeReadView,
  RuntimeError,
  PendingCommand,
} from "@proophboard/exploration-runtime";
import {
  foldChapter,
  deriveRuntimeSteps,
  toImplicitScenario,
  toClassName,
} from "@proophboard/exploration-runtime";
import { transpileHandlers } from "./transpile.js";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface ScenarioRunOutput {
  scenarioId: string;
  scenarioName: string;
  /** Events emitted across all steps up to the playhead. */
  events: RuntimeEvent[];
  /** Final projection state tree. */
  state: Record<string, unknown>;
  /** Information `read()` derived views at the playhead. */
  readViews: RuntimeReadView[];
  /** Runtime errors (threw / rejected / cascade-exceeded), tagged by sliceId. */
  errors: RuntimeError[];
  /** Automation commands that never reached their target slice. */
  pendingCommands: PendingCommand[];
  /** ISO clock value used for the fold (undefined when scenario has no clock). */
  clockISO: string | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute `scenario` against `chapter`.
 *
 * @param chapter       Fully loaded chapter (from loadChapterFromDisk).
 * @param scenario      Scenario to run (from loadScenarioFromDisk).
 * @param playheadIndex Optional step index; defaults to the final step.
 */
export async function runScenarioFromDisk(
  chapter: Chapter,
  scenario: Scenario,
  playheadIndex?: number,
): Promise<ScenarioRunOutput> {
  // 1. Transpile all authored play functions.
  const { handlers, errors: transpileErrors } = await transpileHandlers(chapter);

  // 2. Determine playhead (default: last step).
  const steps = deriveRuntimeSteps(chapter);
  const playhead = playheadIndex ?? steps.length - 1;

  // 3. Fold.
  const result = foldChapter(
    chapter,
    toImplicitScenario(scenario),
    playhead,
    handlers,
    undefined,
    undefined,
    "PlayWorker",
  );

  // 4. Merge transpile errors (before fold errors so they sort first).
  const allErrors: RuntimeError[] = [
    ...transpileErrors,
    ...(result.errors ?? []),
  ];

  // 5. Supplement read views with "lookup" information elements — those that have
  //    no authored read() handler. The browser shows these as the raw projection
  //    state value (state[Context][ElementName]). We do the same here.
  //    De-duplicate by key: authored read() views take priority; lookups fill gaps.
  //    Elements are sorted by slice index in the loader, so iterating them in order
  //    and overwriting means the last-slice (latest timeline) value wins.
  const authoredKeys = new Set((result.readViews ?? []).map((rv) => rv.key));
  const lookupMap = new Map<string, RuntimeReadView>();
  for (const el of chapter.elements) {
    if (el.type !== "information") continue;
    if (el.playFunction?.trim()) continue;          // has a read handler — already in readViews
    const ctxKey = toClassName(el.context || "App");
    const elKey  = toClassName(el.name);
    const key    = `${ctxKey}.${elKey}`;
    if (authoredKeys.has(key)) continue;            // authored view covers this key
    const ctxState = (result.state as Record<string, Record<string, unknown>>)[ctxKey];
    const value = ctxState?.[elKey];
    if (value !== undefined) {
      lookupMap.set(key, { elementId: el.id, key, view: value });
    }
  }

  const allReadViews: RuntimeReadView[] = [
    ...(result.readViews ?? []),
    ...lookupMap.values(),
  ];

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    events: result.events,
    state: result.state as Record<string, unknown>,
    readViews: allReadViews,
    errors: allErrors,
    pendingCommands: result.pendingCommands ?? [],
    clockISO: result.clockISO,
  };
}
