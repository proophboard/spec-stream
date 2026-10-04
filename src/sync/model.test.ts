import { describe, it, expect } from "vitest";
import {
  emptyModel,
  elementDetailsKey,
  laneDetailsKey,
  parseElementDetailsKey,
  parseLaneDetailsKey,
  slicesOfChapter,
  lanesOfChapter,
  elementsInCell,
  type ModelState,
  type SliceState,
  type LaneState,
  type ElementState,
} from "./model.js";

function slice(id: string, chapterId: string, index: number): SliceState {
  return { id, label: id, chapterId, index, details: "", comments: [] };
}
function lane(id: string, chapterId: string, index: number): LaneState {
  return { id, label: id, type: "user-lane", chapterId, index };
}
function element(id: string, laneId: string, sliceId: string, index: number): ElementState {
  return {
    id,
    type: "command",
    name: id,
    context: "App",
    description: "",
    details: "",
    laneId,
    sliceId,
    chapterId: "c1",
    index,
    comments: [],
  };
}

function seed(): ModelState {
  const m = emptyModel("ws", "WS");
  m.chapters.set("c1", {
    id: "c1",
    name: "Chapter",
    context: "App",
    index: 0,
    mode: "event-modeling",
    sliceOrder: ["s2", "s1"], // deliberately not id-sorted
    laneOrder: ["l1", "l2"],
  });
  m.slices.set("s1", slice("s1", "c1", 1));
  m.slices.set("s2", slice("s2", "c1", 0));
  m.lanes.set("l1", lane("l1", "c1", 0));
  m.lanes.set("l2", lane("l2", "c1", 1));
  m.elements.set("e1", element("e1", "l1", "s1", 1));
  m.elements.set("e2", element("e2", "l1", "s1", 0));
  m.elements.set("e3", element("e3", "l2", "s1", 0));
  return m;
}

describe("detail keys", () => {
  it("builds and parses element-details keys", () => {
    const k = elementDetailsKey("App", "command", "Place Order");
    expect(parseElementDetailsKey(k)).toEqual({
      context: "App",
      type: "command",
      name: "Place Order",
    });
  });

  it("builds and parses lane-details keys", () => {
    const k = laneDetailsKey("user-lane", "Customer");
    expect(parseLaneDetailsKey(k)).toEqual({ type: "user-lane", name: "Customer" });
  });

  it("keys are distinct across fields", () => {
    expect(elementDetailsKey("A", "command", "X")).not.toBe(
      elementDetailsKey("A", "event", "X"),
    );
  });
});

describe("ordered queries", () => {
  it("returns child slices in chapter order (not id order)", () => {
    const m = seed();
    expect(slicesOfChapter(m, "c1").map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("returns child lanes in chapter order", () => {
    const m = seed();
    expect(lanesOfChapter(m, "c1").map((l) => l.id)).toEqual(["l1", "l2"]);
  });

  it("returns elements in a cell sorted by index", () => {
    const m = seed();
    expect(elementsInCell(m, "l1", "s1").map((e) => e.id)).toEqual(["e2", "e1"]);
  });

  it("isolates cells by lane and slice", () => {
    const m = seed();
    expect(elementsInCell(m, "l2", "s1").map((e) => e.id)).toEqual(["e3"]);
    expect(elementsInCell(m, "l1", "s2")).toEqual([]);
  });

  it("returns empty for unknown chapter", () => {
    const m = seed();
    expect(slicesOfChapter(m, "nope")).toEqual([]);
    expect(lanesOfChapter(m, "nope")).toEqual([]);
  });
});
