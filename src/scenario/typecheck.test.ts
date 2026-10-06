import { describe, it, expect, beforeAll } from "vitest";
import type { Chapter, Element } from "@proophboard/exploration-runtime";
import { typecheckChapter, typecheckElement } from "./typecheck.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeChapter(elements: Element[]): Chapter {
  const sliceIds = [...new Set(elements.map((e) => e.sliceId))];
  const laneIds = [...new Set(elements.map((e) => e.laneId))];
  return {
    id: "chap-1",
    name: "Todo",
    context: "App",
    mode: "event-modeling",
    index: 0,
    sliceOrder: sliceIds,
    laneOrder: laneIds,
    slices: sliceIds.map((id, i) => ({ id, label: id, index: i })),
    lanes: [
      { id: "lane-info", label: "Info Flow", type: "information-flow", index: 0 },
      { id: "lane-sys",  label: "System",    type: "system",           index: 1 },
    ],
    elements,
  };
}

function cmd(overrides: Partial<Element> = {}): Element {
  return {
    id: "el-cmd",
    type: "command",
    name: "Add Todo",
    context: "App",
    laneId: "lane-info",
    sliceId: "slice-write",
    index: 0,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Load ts once for synchronous tests
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ts: any;
beforeAll(async () => {
  ts = await import("typescript");
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("typecheckElement — valid handler", () => {
  it("returns zero diagnostics for an empty play function", () => {
    const element = cmd({ playFunction: "" });
    const chapter = makeChapter([element]);
    const diags = typecheckElement(ts, chapter, element);
    expect(diags).toHaveLength(0);
  });

  it("returns zero diagnostics for a simple valid decide function", () => {
    const element = cmd({
      playFunction: `function decide(payload, state) {
  return [{ name: 'Todo Added', payload: {} }];
}`,
    });
    const chapter = makeChapter([
      element,
      { id: "el-evt", type: "event", name: "Todo Added", context: "App", laneId: "lane-sys", sliceId: "slice-write", index: 0 },
    ]);
    const diags = typecheckElement(ts, chapter, element);
    expect(diags).toHaveLength(0);
  });
});

describe("typecheckElement — invalid play-type", () => {
  it("reports a parse error when play-type is missing 'type Payload =' wrapper", () => {
    // playType stores the bare expression; if it's syntactically broken as a type literal
    // parsePlayType will return ok: false
    const element = cmd({ playType: "{ unclosed" });
    const chapter = makeChapter([element]);
    const diags = typecheckElement(ts, chapter, element);
    // Should surface at least one diagnostic (parse error)
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0]!.kind).toBe("play-type");
    expect(diags[0]!.elementId).toBe("el-cmd");
  });

  it("returns zero diagnostics for a valid play-type", () => {
    const element = cmd({ playType: "{ name: string }" });
    const chapter = makeChapter([element]);
    const diags = typecheckElement(ts, chapter, element);
    expect(diags).toHaveLength(0);
  });
});

describe("typecheckElement — diagnostic shape", () => {
  it("returns diagnostics with correct fields (elementId, elementName, kind, line, col, code, message)", () => {
    // A syntax error in the play function
    const element = cmd({ playFunction: "function decide( {" });
    const chapter = makeChapter([element]);
    const diags = typecheckElement(ts, chapter, element);
    expect(diags.length).toBeGreaterThan(0);
    const d = diags[0]!;
    expect(d.elementId).toBe("el-cmd");
    expect(d.elementName).toBe("Add Todo");
    expect(d.elementType).toBe("command");
    expect(d.kind).toBe("play-function");
    expect(typeof d.line).toBe("number");
    expect(typeof d.col).toBe("number");
    expect(typeof d.code).toBe("number");
    expect(typeof d.message).toBe("string");
  });
});

describe("typecheckChapter (async)", () => {
  it("returns zero diagnostics when all elements have valid play functions", async () => {
    const chapter = makeChapter([
      cmd({ playFunction: `function decide(p, s) { return [{ name: 'Todo Added', payload: {} }]; }` }),
      { id: "el-evt", type: "event", name: "Todo Added", context: "App", laneId: "lane-sys", sliceId: "slice-write", index: 0 },
    ]);
    const diags = await typecheckChapter(chapter);
    expect(diags).toHaveLength(0);
  });

  it("skips elements with no playFunction or playType", async () => {
    const chapter = makeChapter([
      { id: "el-ui", type: "ui", name: "Form", context: "App", laneId: "lane-info", sliceId: "slice-ui", index: 0 },
    ]);
    const diags = await typecheckChapter(chapter);
    expect(diags).toHaveLength(0);
  });

  it("collects diagnostics from all elements", async () => {
    const chapter = makeChapter([
      cmd({ id: "el-1", playFunction: "function decide( {" }),
      cmd({ id: "el-2", name: "Remove Todo", playFunction: "function decide( {" }),
    ]);
    const diags = await typecheckChapter(chapter);
    const ids = new Set(diags.map((d) => d.elementId));
    expect(ids.has("el-1")).toBe(true);
    expect(ids.has("el-2")).toBe(true);
  });
});
