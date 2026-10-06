import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "../sync/render.js";
import { writeTree } from "../sync/writer.js";
import { seedModelFromData } from "../sync/seed.js";
import type { ApiChapter, ApiScenario } from "../sync/restClient.js";
import { resolveChapterDir } from "./loadChapter.js";
import {
  loadScenarioFromDisk,
  listScenarioDirs,
  resolveScenarioDir,
} from "./loadScenario.js";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal fixture
// ─────────────────────────────────────────────────────────────────────────────

const BASE_CHAPTER: ApiChapter = {
  id: "chap-1",
  name: "Todo App",
  context: "App",
  mode: "event-modeling",
  index: 0,
  lanes: [
    { id: "lane-info", label: "Info Flow", type: "information-flow", index: 0 },
  ] as Record<string, unknown>[],
  slices: [
    { id: "slice-0", label: "Add Todo", index: 0 },
    { id: "slice-1", label: "List Todos", index: 1 },
  ] as Record<string, unknown>[],
  elements: [
    { id: "el-cmd", type: "command", name: "Add Todo", context: "App",
      laneId: "lane-info", sliceId: "slice-0", index: 0 },
    { id: "el-info", type: "information", name: "Todo List", context: "App",
      laneId: "lane-info", sliceId: "slice-1", index: 0 },
  ] as Record<string, unknown>[],
};

const SCENARIO_A: ApiScenario = {
  id: "sc-1",
  chapter_id: "chap-1",
  name: "Happy Path",
  clock: "2024-01-01T00:00:00Z",
  seeded_events: [],
  interactions: [],
  initial_state: {},
  expectations: [
    {
      id: "exp-1",
      sliceId: "slice-1",
      kind: "information",
      elementId: "el-info",
      match: "subset",
      expected: { value: [], view: "read" },
    },
  ],
};

const SCENARIO_B: ApiScenario = {
  id: "sc-2",
  chapter_id: "chap-1",
  name: "Empty State",
  interactions: [],
  seeded_events: [],
  initial_state: {},
  expectations: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let root: string;
let chapterDir: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "spec-stream-loadScenario-"));
  const scenariosByChapter = new Map([["chap-1", [SCENARIO_A, SCENARIO_B]]]);
  const state = seedModelFromData("ws-1", "Test WS", [BASE_CHAPTER], [], scenariosByChapter);
  writeTree(root, render(state));
  chapterDir = await resolveChapterDir(root, "chap-1");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("loadScenarioFromDisk", () => {
  it("round-trips basic fields: id, name, chapterId, clock", async () => {
    const dir = await resolveScenarioDir(chapterDir, "sc-1");
    const sc = await loadScenarioFromDisk(dir);

    expect(sc.id).toBe("sc-1");
    expect(sc.name).toBe("Happy Path");
    expect(sc.chapterId).toBe("chap-1");
    expect(sc.clock).toBe("2024-01-01T00:00:00Z");
  });

  it("round-trips expectations array including kind, sliceId, match, and expected", async () => {
    const dir = await resolveScenarioDir(chapterDir, "sc-1");
    const sc = await loadScenarioFromDisk(dir);

    expect(sc.expectations).toHaveLength(1);
    const exp = sc.expectations![0]!;
    expect(exp.id).toBe("exp-1");
    expect(exp.sliceId).toBe("slice-1");
    expect(exp.kind).toBe("information");
    expect(exp.elementId).toBe("el-info");
    expect(exp.match).toBe("subset");
    expect(exp.expected).toEqual({ value: [], view: "read" });
  });

  it("returns undefined expectations when the scenario has none", async () => {
    const dir = await resolveScenarioDir(chapterDir, "sc-2");
    const sc = await loadScenarioFromDisk(dir);
    // Empty array in source — rendered as absent (render omits empty arrays)
    expect(sc.expectations == null || sc.expectations.length === 0).toBe(true);
  });
});

describe("listScenarioDirs", () => {
  it("returns one entry per scenario", async () => {
    const dirs = await listScenarioDirs(chapterDir);
    expect(dirs).toHaveLength(2);
  });

  it("returns absolute paths that contain a scenario.json", async () => {
    const dirs = await listScenarioDirs(chapterDir);
    for (const dir of dirs) {
      const { existsSync } = await import("node:fs");
      expect(existsSync(join(dir, "scenario.json"))).toBe(true);
    }
  });
});

describe("resolveScenarioDir", () => {
  it("resolves by exact id", async () => {
    const dir = await resolveScenarioDir(chapterDir, "sc-1");
    const { readFile } = await import("node:fs/promises");
    const json = JSON.parse(await readFile(join(dir, "scenario.json"), "utf8"));
    expect(json.id).toBe("sc-1");
  });

  it("resolves by exact name", async () => {
    const dir = await resolveScenarioDir(chapterDir, "Happy Path");
    const { readFile } = await import("node:fs/promises");
    const json = JSON.parse(await readFile(join(dir, "scenario.json"), "utf8"));
    expect(json.name).toBe("Happy Path");
  });

  it("resolves by case-insensitive name", async () => {
    const dir = await resolveScenarioDir(chapterDir, "happy path");
    const { readFile } = await import("node:fs/promises");
    const json = JSON.parse(await readFile(join(dir, "scenario.json"), "utf8"));
    expect(json.name).toBe("Happy Path");
  });

  it("throws when the scenario is not found", async () => {
    await expect(resolveScenarioDir(chapterDir, "nonexistent")).rejects.toThrow(
      /Scenario not found/,
    );
  });
});
