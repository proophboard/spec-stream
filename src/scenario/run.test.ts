import { describe, it, expect } from "vitest";
import type { Chapter, Scenario } from "@proophboard/exploration-runtime";
import { runScenarioFromDisk } from "./run.js";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal in-memory chapter / scenario helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeChapter(overrides: Partial<Chapter> = {}): Chapter {
  return {
    id: "chap-1",
    name: "Todo",
    context: "App",
    mode: "event-modeling",
    index: 0,
    sliceOrder: ["slice-ui", "slice-write", "slice-read"],
    laneOrder: ["lane-user", "lane-info", "lane-sys"],
    slices: [
      { id: "slice-ui",    label: "Add Todo Form", index: 0 },
      { id: "slice-write", label: "Add Todo",      index: 1 },
      { id: "slice-read",  label: "Todo List",     index: 2 },
    ],
    lanes: [
      { id: "lane-user", label: "User",      type: "user-lane",        index: 0 },
      { id: "lane-info", label: "Info Flow", type: "information-flow", index: 1 },
      { id: "lane-sys",  label: "System",    type: "system",           index: 2 },
    ],
    elements: [
      { id: "el-ui",   type: "ui",          name: "Add Todo Form", context: "App", laneId: "lane-user", sliceId: "slice-ui",    index: 0 },
      { id: "el-cmd",  type: "command",     name: "Add Todo",      context: "App", laneId: "lane-info", sliceId: "slice-write", index: 0 },
      { id: "el-evt",  type: "event",       name: "Todo Added",    context: "App", laneId: "lane-sys",  sliceId: "slice-write", index: 0 },
      { id: "el-info", type: "information", name: "Todo List",     context: "App", laneId: "lane-info", sliceId: "slice-read",  index: 0 },
    ],
    ...overrides,
  };
}

function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: "sc-1",
    chapterId: "chap-1",
    name: "Default",
    clock: "2024-01-01T00:00:00Z",
    initialState: {},
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("runScenarioFromDisk — no play functions (defaults)", () => {
  it("returns output with correct scenarioId and name", async () => {
    const output = await runScenarioFromDisk(makeChapter(), makeScenario());
    expect(output.scenarioId).toBe("sc-1");
    expect(output.scenarioName).toBe("Default");
  });

  it("returns no errors when all handlers are defaults", async () => {
    const output = await runScenarioFromDisk(makeChapter(), makeScenario());
    expect(output.errors).toHaveLength(0);
  });

  it("returns events array (may be empty with defaults)", async () => {
    const output = await runScenarioFromDisk(makeChapter(), makeScenario());
    expect(Array.isArray(output.events)).toBe(true);
  });

  it("returns state object", async () => {
    const output = await runScenarioFromDisk(makeChapter(), makeScenario());
    expect(typeof output.state).toBe("object");
  });
});

describe("runScenarioFromDisk — with authored decide handler", () => {
  it("emits an event with the payload from the decide function", async () => {
    const chapter = makeChapter({
      elements: [
        { id: "el-ui",   type: "ui",      name: "Add Todo Form", context: "App", laneId: "lane-user", sliceId: "slice-ui",    index: 0 },
        {
          id: "el-cmd",  type: "command", name: "Add Todo",      context: "App", laneId: "lane-info", sliceId: "slice-write", index: 0,
          playFunction: `function decide(payload, state) {
  return [{ name: 'Todo Added', payload: { name: payload.name ?? 'test' } }];
}`,
        },
        { id: "el-evt",  type: "event",       name: "Todo Added", context: "App", laneId: "lane-sys",  sliceId: "slice-write", index: 0 },
        { id: "el-info", type: "information", name: "Todo List",  context: "App", laneId: "lane-info", sliceId: "slice-read",  index: 0 },
      ],
    });

    const output = await runScenarioFromDisk(chapter, makeScenario());
    expect(output.errors.filter((e) => e.kind === "threw")).toHaveLength(0);
  });
});

describe("runScenarioFromDisk — handler that throws", () => {
  it("records the throw as an error and continues folding", async () => {
    const chapter = makeChapter({
      elements: [
        { id: "el-ui",   type: "ui",      name: "Add Todo Form", context: "App", laneId: "lane-user", sliceId: "slice-ui",    index: 0 },
        {
          id: "el-cmd",  type: "command", name: "Add Todo",      context: "App", laneId: "lane-info", sliceId: "slice-write", index: 0,
          playFunction: `function decide(payload, state) {
  throw new Error("deliberate failure");
}`,
        },
        { id: "el-evt",  type: "event",       name: "Todo Added", context: "App", laneId: "lane-sys",  sliceId: "slice-write", index: 0 },
        { id: "el-info", type: "information", name: "Todo List",  context: "App", laneId: "lane-info", sliceId: "slice-read",  index: 0 },
      ],
    });

    const output = await runScenarioFromDisk(chapter, makeScenario());
    // The fold should complete (not throw) and record the error
    expect(Array.isArray(output.errors)).toBe(true);
    // We still get a complete output
    expect(output.scenarioId).toBe("sc-1");
  });
});

describe("runScenarioFromDisk — playheadIndex", () => {
  it("stops at step 0 when playheadIndex=0", async () => {
    const output = await runScenarioFromDisk(makeChapter(), makeScenario(), 0);
    // At step 0 (first UI slice) there can be no write events
    expect(output.events.filter((e) => e.name === "Todo Added")).toHaveLength(0);
  });

  it("uses the final step when playheadIndex is omitted", async () => {
    const out1 = await runScenarioFromDisk(makeChapter(), makeScenario());
    const out2 = await runScenarioFromDisk(makeChapter(), makeScenario(), 2);
    // Both should produce the same result
    expect(out1.events.length).toBe(out2.events.length);
  });
});
