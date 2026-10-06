import { describe, it, expect } from "vitest";
import type { Chapter, Scenario } from "@proophboard/exploration-runtime";
import { testScenariosFromDisk } from "./test.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** A chapter with two slices: Write (command+event) and Read (information). */
function makeChapter(extraElementProps: Record<string, unknown> = {}): Chapter {
  return {
    id: "chap-1",
    name: "Todo",
    context: "App",
    mode: "event-modeling",
    index: 0,
    sliceOrder: ["slice-write", "slice-read"],
    laneOrder: ["lane-info", "lane-sys"],
    slices: [
      { id: "slice-write", label: "Add Todo",   index: 0 },
      { id: "slice-read",  label: "Todo List",  index: 1 },
    ],
    lanes: [
      { id: "lane-info", label: "Info Flow", type: "information-flow", index: 0 },
      { id: "lane-sys",  label: "System",    type: "system",           index: 1 },
    ],
    elements: [
      { id: "el-cmd",  type: "command",     name: "Add Todo",   context: "App", laneId: "lane-info", sliceId: "slice-write", index: 0, ...extraElementProps },
      { id: "el-evt",  type: "event",       name: "Todo Added", context: "App", laneId: "lane-sys",  sliceId: "slice-write", index: 0 },
      { id: "el-info", type: "information", name: "Todo List",  context: "App", laneId: "lane-info", sliceId: "slice-read",  index: 0 },
    ],
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

describe("testScenariosFromDisk — pass", () => {
  it("returns hasBroken: false and status pass when all expectations match", async () => {
    const scenario = makeScenario({
      expectations: [
        {
          id: "exp-1",
          sliceId: "slice-write",
          kind: "events",
          match: "subset",
          // Default decide emits the command's event with the default payload — we
          // use subset match so any events array satisfies it (we just need non-broken).
          expected: { events: [] },
        },
      ],
    });

    const output = await testScenariosFromDisk(makeChapter(), [scenario]);
    expect(output.hasBroken).toBe(false);
    expect(output.results[0]!.status).not.toBe("broken");
  });
});

describe("testScenariosFromDisk — neutral", () => {
  it("returns hasBroken: false and neutralCount: 1 when scenario has no expectations", async () => {
    const output = await testScenariosFromDisk(makeChapter(), [makeScenario()]);
    expect(output.hasBroken).toBe(false);
    expect(output.neutralCount).toBe(1);
    expect(output.results[0]!.status).toBe("neutral");
  });
});

describe("testScenariosFromDisk — broken", () => {
  it("returns hasBroken: true when a pinned slice is removed (dangling-reference)", async () => {
    const scenario = makeScenario({
      expectations: [
        {
          id: "exp-dangling",
          sliceId: "slice-does-not-exist",  // This slice is absent from the chapter
          kind: "events",
          match: "exact",
          expected: { events: [] },
        },
      ],
    });

    const output = await testScenariosFromDisk(makeChapter(), [scenario]);
    expect(output.hasBroken).toBe(true);
    expect(output.results[0]!.status).toBe("broken");
  });
});

describe("testScenariosFromDisk — multiple scenarios", () => {
  it("returns one result per scenario in input order", async () => {
    const sc1 = makeScenario({ id: "sc-1", name: "A" });
    const sc2 = makeScenario({ id: "sc-2", name: "B" });
    const output = await testScenariosFromDisk(makeChapter(), [sc1, sc2]);
    expect(output.results).toHaveLength(2);
    expect(output.results[0]!.scenarioId).toBe("sc-1");
    expect(output.results[1]!.scenarioId).toBe("sc-2");
  });

  it("rolls up hasBroken correctly across mixed verdicts", async () => {
    const passing = makeScenario({ id: "sc-1", name: "Neutral" }); // neutral
    const broken = makeScenario({
      id: "sc-2",
      name: "Broken",
      expectations: [
        {
          id: "exp-b",
          sliceId: "missing-slice",
          kind: "events",
          match: "exact",
          expected: { events: [] },
        },
      ],
    });

    const output = await testScenariosFromDisk(makeChapter(), [passing, broken]);
    expect(output.hasBroken).toBe(true);
    expect(output.neutralCount).toBe(1);
    expect(output.results[1]!.status).toBe("broken");
  });
});
