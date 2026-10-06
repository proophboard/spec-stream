/**
 * Run Exploration Mode scenarios as tests — evaluate pinned expectations and
 * report pass / broken / neutral verdicts.
 *
 * This is a thin wrapper over `runScenario` / `runAllScenarios` from the runtime
 * package. The only spec-stream-specific logic is transpiling handlers and
 * deriving the `hasBroken` exit-code flag.
 */

import type { Chapter, Scenario, ScenarioRunResult } from "@proophboard/exploration-runtime";
import { runAllScenarios } from "@proophboard/exploration-runtime";
import { transpileHandlers } from "./transpile.js";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface ScenarioTestOutput {
  /** One result per scenario, in the same order as the input `scenarios` array. */
  results: ScenarioRunResult[];
  /** true if any scenario has status 'broken' — caller should exit 1. */
  hasBroken: boolean;
  /** Number of scenarios with status 'neutral' (no expectations pinned). */
  neutralCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run all `scenarios` as tests against `chapter`.
 *
 * Transpiles handlers once, then evaluates every scenario's pinned expectations.
 * Returns structured results and a `hasBroken` flag suitable for driving an exit code.
 */
export async function testScenariosFromDisk(
  chapter: Chapter,
  scenarios: Scenario[],
): Promise<ScenarioTestOutput> {
  const { handlers } = await transpileHandlers(chapter);

  const results = runAllScenarios(chapter, scenarios, handlers);

  const hasBroken = results.some((r) => r.status === "broken");
  const neutralCount = results.filter((r) => r.status === "neutral").length;

  return { results, hasBroken, neutralCount };
}
