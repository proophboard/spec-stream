/**
 * Load Exploration Mode scenarios from the local-sync file tree.
 *
 * Scenarios for a chapter live at:
 *   chapters/[Ctx]/[id]_[Name]/scenarios/[id]_[Name]/scenario.json
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Scenario } from "@proophboard/exploration-runtime";
import { globby } from "./globby.js";

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load a single scenario from its directory.
 *
 * @param scenarioDir Absolute path to the scenario directory
 *   (e.g. `.spec-stream/model/chapters/App/chap-1_Todo/scenarios/sc-1_Happy-Path`).
 */
export async function loadScenarioFromDisk(scenarioDir: string): Promise<Scenario> {
  const raw = await readFile(join(scenarioDir, "scenario.json"), "utf8");
  const json = JSON.parse(raw) as ScenarioJson;

  return {
    id: json.id,
    chapterId: json.chapterId,
    name: json.name,
    clock: json.clock,
    initialState: (json.initialState ?? {}) as Record<string, Record<string, unknown>>,
    seededEvents: json.seededEvents,
    interactions: json.interactions,
    expectations: json.expectations,
  };
}

/**
 * Return the absolute paths of all scenario directories for the given chapter directory.
 */
export async function listScenarioDirs(chapterDir: string): Promise<string[]> {
  const jsonPaths = await globby("scenarios/*/scenario.json", chapterDir);
  // Parent directory of each scenario.json
  return jsonPaths.map((p) => p.slice(0, -"scenario.json".length - 1));
}

/**
 * Resolve a scenario directory inside `chapterDir` by scenario id or name.
 *
 * Matching order:
 *   1. Exact id match
 *   2. Exact name match
 *   3. Case-insensitive name match (first)
 *
 * Throws if no match is found.
 */
export async function resolveScenarioDir(
  chapterDir: string,
  idOrName: string,
): Promise<string> {
  const dirs = await listScenarioDirs(chapterDir);
  if (dirs.length === 0) {
    throw new Error(`No scenarios found in chapter directory: ${chapterDir}`);
  }

  // Load all scenario.json files (small, just id + name needed).
  const entries = await Promise.all(
    dirs.map(async (dir) => {
      const raw = await readFile(join(dir, "scenario.json"), "utf8");
      const json = JSON.parse(raw) as { id: string; name: string };
      return { dir, id: json.id, name: json.name };
    }),
  );

  // 1. Exact id
  const byId = entries.find((e) => e.id === idOrName);
  if (byId) return byId.dir;

  // 2. Exact name
  const byName = entries.find((e) => e.name === idOrName);
  if (byName) return byName.dir;

  // 3. Case-insensitive name
  const lower = idOrName.toLowerCase();
  const byNameCI = entries.find((e) => e.name.toLowerCase() === lower);
  if (byNameCI) return byNameCI.dir;

  throw new Error(
    `Scenario not found: "${idOrName}". Available: ${entries.map((e) => `"${e.name}" (${e.id})`).join(", ")}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// On-disk JSON shape
// ─────────────────────────────────────────────────────────────────────────────

interface ScenarioJson {
  id: string;
  chapterId: string;
  name: string;
  clock?: string;
  initialState?: Record<string, unknown>;
  seededEvents?: Scenario["seededEvents"];
  interactions?: Scenario["interactions"];
  expectations?: Scenario["expectations"];
  createdAt?: string;
  updatedAt?: string;
}
