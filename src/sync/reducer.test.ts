import { describe, it, expect } from "vitest";
import { applyEvent } from "./reducer.js";
import {
  emptyModel,
  elementDetailsKey,
  type ModelState,
} from "./model.js";
import type { ChangelogEvent } from "../realtime/events.js";

function ev(type: string, overrides: Partial<ChangelogEvent> = {}): ChangelogEvent {
  return {
    id: "e",
    type,
    timestamp: 1,
    workspaceId: "ws",
    chapterId: "c1",
    chapterName: "Chapter",
    sliceId: undefined,
    userId: "u",
    addedByAgent: false,
    createdAt: "2026-10-03T00:00:00Z",
    data: {},
    row: {} as ChangelogEvent["row"],
    ...overrides,
  };
}

/** Build a model with a chapter, one slice, one lane. */
function base(): ModelState {
  const s = emptyModel("ws", "WS");
  applyEvent(s, ev("chapter-added", { chapterId: "c1", context: "App", data: { newValue: { id: "c1", name: "Chapter", mode: "event-modeling" } } }));
  applyEvent(s, ev("slice-added", { chapterId: "c1", data: { newValue: { slice: { id: "s1", label: "Slice One", index: 0, status: "draft" } } } }));
  applyEvent(s, ev("lane-added", { chapterId: "c1", data: { newValue: { lane: { id: "l1", label: "Lane One", type: "user-lane", index: 0 } } } }));
  return s;
}

describe("chapter events", () => {
  it("adds, renames, edits context, removes", () => {
    const s = base();
    expect(s.chapters.get("c1")?.name).toBe("Chapter");

    applyEvent(s, ev("chapter-renamed", { chapterId: "c1", data: { newValue: { name: "Renamed" } } }));
    expect(s.chapters.get("c1")?.name).toBe("Renamed");

    applyEvent(s, ev("chapter-edited", { chapterId: "c1", data: { newValue: { name: "Final", context: "Ops" } } }));
    expect(s.chapters.get("c1")?.context).toBe("Ops");

    applyEvent(s, ev("chapter-removed", { chapterId: "c1", data: {} }));
    expect(s.chapters.has("c1")).toBe(false);
    expect(s.slices.has("s1")).toBe(false); // cascade
    expect(s.lanes.has("l1")).toBe(false);
  });

  it("reorders chapters by index", () => {
    const s = base();
    applyEvent(s, ev("chapter-added", { chapterId: "c2", context: "App", data: { newValue: { id: "c2", name: "Two" } } }));
    applyEvent(s, ev("chapters-reordered", { data: { newValue: { chapterIds: ["c2", "c1"] } } }));
    expect(s.chapters.get("c2")?.index).toBe(0);
    expect(s.chapters.get("c1")?.index).toBe(1);
  });
});

describe("slice events", () => {
  it("tracks label, status, details, width, icon", () => {
    const s = base();
    applyEvent(s, ev("slice-renamed", { sliceId: "s1", data: { newValue: { label: "New Label" } } }));
    applyEvent(s, ev("slice-status-changed", { sliceId: "s1", data: { newValue: { status: "planned" } } }));
    applyEvent(s, ev("slice-details-changed", { sliceId: "s1", data: { newValue: { details: "## Spec" } } }));
    const sl = s.slices.get("s1")!;
    expect(sl.label).toBe("New Label");
    expect(sl.status).toBe("planned");
    expect(sl.details).toBe("## Spec");
  });

  it("adds/changes/removes slice comments", () => {
    const s = base();
    applyEvent(s, ev("new-slice-comment-written", { sliceId: "s1", data: { newValue: { comment: { id: "cm1", text: "hi", author: "A" } } } }));
    expect(s.slices.get("s1")?.comments).toHaveLength(1);
    applyEvent(s, ev("slice-comment-changed", { sliceId: "s1", data: { newValue: { commentId: "cm1", text: "edited" } } }));
    expect(s.slices.get("s1")?.comments[0].text).toBe("edited");
    applyEvent(s, ev("slice-comment-removed", { sliceId: "s1", data: { newValue: { commentId: "cm1" } } }));
    expect(s.slices.get("s1")?.comments).toHaveLength(0);
  });

  it("reorders slices and updates chapter order", () => {
    const s = base();
    applyEvent(s, ev("slice-added", { chapterId: "c1", data: { newValue: { slice: { id: "s2", label: "Two", index: 1 } } } }));
    applyEvent(s, ev("slices-reordered", { chapterId: "c1", data: { newValue: { sliceIds: ["s2", "s1"] } } }));
    expect(s.chapters.get("c1")?.sliceOrder).toEqual(["s2", "s1"]);
    expect(s.slices.get("s2")?.index).toBe(0);
  });

  it("removes a slice and its elements", () => {
    const s = base();
    applyEvent(s, ev("element-added", { chapterId: "c1", data: { newValue: { element: { id: "el1", type: "command", name: "X", context: "App", laneId: "l1", sliceId: "s1", index: 0 } } } }));
    applyEvent(s, ev("slice-removed", { sliceId: "s1", data: {} }));
    expect(s.slices.has("s1")).toBe(false);
    expect(s.elements.has("el1")).toBe(false);
  });
});

describe("lane events", () => {
  it("renames, re-icons, resizes, removes", () => {
    const s = base();
    applyEvent(s, ev("lane-renamed", { data: { laneId: "l1", newValue: { label: "Lane X" } } }));
    expect(s.lanes.get("l1")?.label).toBe("Lane X");
    applyEvent(s, ev("lane-resized", { data: { laneId: "l1", newValue: { height: 200 } } }));
    expect(s.lanes.get("l1")?.height).toBe(200);
    applyEvent(s, ev("lane-removed", { data: { laneId: "l1" } }));
    expect(s.lanes.has("l1")).toBe(false);
  });

  it("shares lane details across lanes with same type+name", () => {
    const s = base();
    applyEvent(s, ev("lane-added", { chapterId: "c1", data: { newValue: { lane: { id: "l2", label: "Lane One", type: "user-lane", index: 1 } } } }));
    applyEvent(s, ev("lane-details-changed", { data: { laneId: "l1", newValue: { details: "shared" } } }));
    const key = s.sharedLaneDetails.get([...s.sharedLaneDetails.keys()].find((k) => k.includes("Lane One"))!);
    expect(key?.body).toBe("shared");
    expect(key?.members.size).toBe(2);
  });
});

describe("element events", () => {
  function withElement(s: ModelState, id: string, name: string, details = "") {
    applyEvent(s, ev("element-added", { chapterId: "c1", data: { newValue: { element: { id, type: "command", name, context: "App", laneId: "l1", sliceId: "s1", index: 0, details } } } }));
  }

  it("adds, describes, moves, reorders, removes", () => {
    const s = base();
    withElement(s, "el1", "Place Order");
    applyEvent(s, ev("element-description-changed", { elementId: "el1", data: { newValue: { description: "desc" } } }));
    expect(s.elements.get("el1")?.description).toBe("desc");

    applyEvent(s, ev("element-moved", { elementId: "el1", data: { newValue: { laneId: "l1", sliceId: "s1", index: 3 } } }));
    expect(s.elements.get("el1")?.index).toBe(3);

    applyEvent(s, ev("element-removed", { elementId: "el1", data: {} }));
    expect(s.elements.has("el1")).toBe(false);
  });

  it("shares details across same context+type+name and fans out", () => {
    const s = base();
    withElement(s, "el1", "Place Order");
    withElement(s, "el2", "Place Order"); // same group
    applyEvent(s, ev("element-details-changed", { elementId: "el1", data: { newValue: { details: "## shared body" } } }));
    expect(s.elements.get("el1")?.details).toBe("## shared body");
    expect(s.elements.get("el2")?.details).toBe("## shared body"); // fan-out
    const key = elementDetailsKey("App", "command", "Place Order");
    expect(s.sharedElementDetails.get(key)?.members.size).toBe(2);
  });

  it("synchronize event fans out identically", () => {
    const s = base();
    withElement(s, "el1", "Order");
    withElement(s, "el2", "Order");
    applyEvent(s, ev("element-details-synchronized", { elementId: "el2", data: { newValue: { details: "synced" } } }));
    expect(s.elements.get("el1")?.details).toBe("synced");
    expect(s.elements.get("el2")?.details).toBe("synced");
  });

  it("rename splits a shared-details group", () => {
    const s = base();
    withElement(s, "el1", "Shared");
    withElement(s, "el2", "Shared");
    applyEvent(s, ev("element-details-changed", { elementId: "el1", data: { newValue: { details: "body" } } }));
    const oldKey = elementDetailsKey("App", "command", "Shared");
    expect(s.sharedElementDetails.get(oldKey)?.members.size).toBe(2);

    applyEvent(s, ev("element-renamed", { elementId: "el2", data: { newValue: { name: "Different" } } }));
    expect(s.sharedElementDetails.get(oldKey)?.members.size).toBe(1); // el1 remains
    const newKey = elementDetailsKey("App", "command", "Different");
    expect(s.sharedElementDetails.get(newKey)?.members.has("el2")).toBe(true);
  });

  it("rename merges into an existing group and adopts its body", () => {
    const s = base();
    withElement(s, "el1", "Target");
    applyEvent(s, ev("element-details-changed", { elementId: "el1", data: { newValue: { details: "target body" } } }));
    withElement(s, "el2", "Other");
    applyEvent(s, ev("element-renamed", { elementId: "el2", data: { newValue: { name: "Target" } } }));
    expect(s.elements.get("el2")?.details).toBe("target body"); // adopted
    const key = elementDetailsKey("App", "command", "Target");
    expect(s.sharedElementDetails.get(key)?.members.size).toBe(2);
  });

  it("handles element comments", () => {
    const s = base();
    withElement(s, "el1", "X");
    applyEvent(s, ev("element-comment-added", { elementId: "el1", data: { newValue: { id: "c1", text: "note", author: "A" } } }));
    expect(s.elements.get("el1")?.comments[0].text).toBe("note");
    applyEvent(s, ev("element-comment-updated", { elementId: "el1", data: { commentId: "c1", newValue: { text: "edited" } } }));
    expect(s.elements.get("el1")?.comments[0].text).toBe("edited");
    applyEvent(s, ev("element-comment-removed", { elementId: "el1", data: { commentId: "c1" } }));
    expect(s.elements.get("el1")?.comments).toHaveLength(0);
  });

  it("element-config-changed applies playFunction and playType", () => {
    const s = base();
    withElement(s, "el1", "Place Order");
    expect(s.elements.get("el1")?.playFunction).toBeUndefined();
    expect(s.elements.get("el1")?.playType).toBeUndefined();

    applyEvent(s, ev("element-config-changed", { elementId: "el1", data: { newValue: { playFunction: "async function play() {}" } } }));
    expect(s.elements.get("el1")?.playFunction).toBe("async function play() {}");
    expect(s.elements.get("el1")?.playType).toBeUndefined();

    applyEvent(s, ev("element-config-changed", { elementId: "el1", data: { newValue: { playType: "type Input = { orderId: string }" } } }));
    expect(s.elements.get("el1")?.playFunction).toBe("async function play() {}"); // unchanged
    expect(s.elements.get("el1")?.playType).toBe("type Input = { orderId: string }");
  });

  it("element-config-changed still applies icon/noArrow fields alongside play fields", () => {
    const s = base();
    withElement(s, "el1", "Place Order");
    applyEvent(s, ev("element-config-changed", { elementId: "el1", data: { newValue: { icon: "star", noArrowSource: true, playFunction: "fn()" } } }));
    const el = s.elements.get("el1")!;
    expect(el.icon).toBe("star");
    expect(el.noArrowSource).toBe(true);
    expect(el.playFunction).toBe("fn()");
  });

  it("element-config-synced applies playFunction and playType", () => {
    const s = base();
    withElement(s, "el1", "Ship Order");
    applyEvent(s, ev("element-config-synced", { elementId: "el1", data: { newValue: { playFunction: "async function play() { return 42; }", playType: "type T = number" } } }));
    const el = s.elements.get("el1")!;
    expect(el.playFunction).toBe("async function play() { return 42; }");
    expect(el.playType).toBe("type T = number");
  });

  it("element-config-synced is a no-op for unknown element ids", () => {
    const s = base();
    expect(() => applyEvent(s, ev("element-config-synced", { elementId: "nope", data: { newValue: { playFunction: "fn()" } } }))).not.toThrow();
  });

  it("putElementFromRaw seeds playFunction/playType from raw data", () => {
    const s = base();
    applyEvent(s, ev("element-added", { chapterId: "c1", data: { newValue: { element: { id: "el2", type: "event", name: "Order Placed", context: "App", laneId: "l1", sliceId: "s1", index: 0, playFunction: "fn()", playType: "type T = void" } } } }));
    expect(s.elements.get("el2")?.playFunction).toBe("fn()");
    expect(s.elements.get("el2")?.playType).toBe("type T = void");
  });
});

describe("milestone events", () => {
  it("adds, updates settings, deletes", () => {
    const s = base();
    applyEvent(s, ev("milestone-added", { data: { newValue: { milestone: { id: "m1", name: "M1", description: "d", slices: [] } } } }));
    expect(s.milestones.get("m1")?.name).toBe("M1");

    applyEvent(s, ev("milestone-settings-changed", { data: { milestoneId: "m1", newValue: { name: "M1b", is_completed: true } } }));
    expect(s.milestones.get("m1")?.name).toBe("M1b");
    expect(s.milestones.get("m1")?.isCompleted).toBe(true);

    applyEvent(s, ev("milestone-deleted", { data: { milestoneId: "m1" } }));
    expect(s.milestones.has("m1")).toBe(false);
  });

  it("syncs slice↔milestone association both ways", () => {
    const s = base();
    applyEvent(s, ev("milestone-added", { data: { newValue: { milestone: { id: "m1", name: "M1", slices: [] } } } }));
    applyEvent(s, ev("slice-milestone-set", { sliceId: "s1", data: { newValue: { sliceId: "s1", milestoneId: "m1", action: "add" } } }));
    expect(s.slices.get("s1")?.milestoneId).toBe("m1");
    expect(s.slices.get("s1")?.milestoneName).toBe("M1");
    expect(s.milestones.get("m1")?.slices.map((r) => r.sliceId)).toContain("s1");

    applyEvent(s, ev("slice-milestone-set", { sliceId: "s1", data: { newValue: { sliceId: "s1", milestoneId: "m1", action: "remove" } } }));
    expect(s.slices.get("s1")?.milestoneId).toBeUndefined();
    expect(s.milestones.get("m1")?.slices).toHaveLength(0);
  });

  it("denormalizes estimate/time-spent onto the slice and milestone ref", () => {
    const s = base();
    applyEvent(s, ev("milestone-added", { data: { newValue: { milestone: { id: "m1", name: "M1", slices: [] } } } }));
    applyEvent(s, ev("slice-milestone-set", { sliceId: "s1", data: { newValue: { sliceId: "s1", milestoneId: "m1", action: "add" } } }));
    applyEvent(s, ev("slice-estimate-set", { sliceId: "s1", data: { newValue: { estimate: "3d" } } }));
    expect(s.slices.get("s1")?.estimate).toBe("3d");
    expect(s.milestones.get("m1")?.slices[0].estimate).toBe("3d");
  });

  it("clears slice milestone fields when milestone deleted", () => {
    const s = base();
    applyEvent(s, ev("milestone-added", { data: { newValue: { milestone: { id: "m1", name: "M1", slices: [{ slice_id: "s1" }] } } } }));
    expect(s.slices.get("s1")?.milestoneId).toBe("m1");
    applyEvent(s, ev("milestone-deleted", { data: { milestoneId: "m1" } }));
    expect(s.slices.get("s1")?.milestoneId).toBeUndefined();
  });
});

describe("robustness", () => {
  it("ignores unknown event types", () => {
    const s = base();
    const before = JSON.stringify([...s.slices.keys()]);
    applyEvent(s, ev("some-future-event", { data: { newValue: { whatever: true } } }));
    expect(JSON.stringify([...s.slices.keys()])).toBe(before);
  });

  it("never throws on malformed payloads", () => {
    const s = base();
    expect(() => applyEvent(s, ev("slice-added", { chapterId: "c1", data: { newValue: {} } }))).not.toThrow();
    expect(() => applyEvent(s, ev("element-added", { chapterId: "c1", data: {} }))).not.toThrow();
    expect(() => applyEvent(s, ev("element-renamed", { elementId: "nope", data: { newValue: { name: "x" } } }))).not.toThrow();
  });

  it("is deterministic — replaying yields the same state", () => {
    const build = () => {
      const s = base();
      applyEvent(s, ev("element-added", { chapterId: "c1", data: { newValue: { element: { id: "el1", type: "command", name: "X", context: "App", laneId: "l1", sliceId: "s1", index: 0 } } } }));
      applyEvent(s, ev("element-description-changed", { elementId: "el1", data: { newValue: { description: "d" } } }));
      return s;
    };
    const a = build();
    const b = build();
    expect([...a.elements.keys()]).toEqual([...b.elements.keys()]);
    expect(a.elements.get("el1")?.description).toBe(b.elements.get("el1")?.description);
  });
});
