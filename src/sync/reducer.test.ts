import { describe, it, expect } from "vitest";
import { applyEvent, emptyDirtySet } from "./reducer.js";
import {
  emptyModel,
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

  it("tracks isTask on slice comments (nested, sibling, and on change)", () => {
    const s = base();
    // isTask inside the comment object
    applyEvent(s, ev("new-slice-comment-written", { sliceId: "s1", data: { newValue: { comment: { id: "cm1", text: "task", isTask: true } } } }));
    expect(s.slices.get("s1")?.comments[0].isTask).toBe(true);
    // isTask as a sibling of comment on newValue
    applyEvent(s, ev("new-slice-comment-written", { sliceId: "s1", data: { newValue: { comment: { id: "cm2", text: "sibling" }, isTask: true } } }));
    expect(s.slices.get("s1")?.comments[1].isTask).toBe(true);
    // is_task snake_case (REST payloads)
    applyEvent(s, ev("new-slice-comment-written", { sliceId: "s1", data: { newValue: { comment: { id: "cm3", text: "snake", is_task: true } } } }));
    expect(s.slices.get("s1")?.comments[2].isTask).toBe(true);
    // changing isTask via slice-comment-changed
    applyEvent(s, ev("slice-comment-changed", { sliceId: "s1", data: { newValue: { commentId: "cm1", isTask: false } } }));
    expect(s.slices.get("s1")?.comments[0].isTask).toBe(false);
  });

  it("reorders slices and updates chapter order", () => {
    const s = base();
    applyEvent(s, ev("slice-added", { chapterId: "c1", data: { newValue: { slice: { id: "s2", label: "Two", index: 1 } } } }));
    applyEvent(s, ev("slices-reordered", { chapterId: "c1", data: { newValue: { sliceIds: ["s2", "s1"] } } }));
    expect(s.chapters.get("c1")?.sliceOrder).toEqual(["s2", "s1"]);
    expect(s.slices.get("s2")?.index).toBe(0);
  });

  it("slices-moved: moves a slice into the slot of a new blank slice (overriddenSliceIds), updates element sliceIds, and re-sorts sliceOrder", () => {
    // Mirrors the real-world prooph board event sequence:
    // 1. slice-added creates a blank placeholder at index 4 ("s-blank")
    // 2. slices-reordered inserts the placeholder into the order
    // 3. slices-moved moves "s1" (Register Lead, was index 0) into that position,
    //    overriding the blank slice — s-blank is consumed and s1 ends up at index 4.
    const s = base();

    // Add three more slices so we have s1(0), s2(1), s3(2), s4(3)
    applyEvent(s, ev("slice-added", { chapterId: "c1", data: { newValue: { slice: { id: "s2", label: "Sign Up View", index: 1, status: "draft" } } } }));
    applyEvent(s, ev("slice-added", { chapterId: "c1", data: { newValue: { slice: { id: "s3", label: "Sign Up", index: 2, status: "draft" } } } }));
    applyEvent(s, ev("slice-added", { chapterId: "c1", data: { newValue: { slice: { id: "s4", label: "New User Sync", index: 3, status: "draft" } } } }));

    // Add elements that belong to s1 (will be moved with it)
    applyEvent(s, ev("element-added", { chapterId: "c1", data: { newValue: { element: { id: "el1", type: "command", name: "Register Lead", context: "App", laneId: "l1", sliceId: "s1", index: 0 } } } }));
    applyEvent(s, ev("element-added", { chapterId: "c1", data: { newValue: { element: { id: "el2", type: "event", name: "Lead Registered", context: "App", laneId: "l1", sliceId: "s1", index: 0 } } } }));

    // Step 1: blank placeholder slice created at index 4
    applyEvent(s, ev("slice-added", { chapterId: "c1", data: { newValue: { slice: { id: "s-blank", label: "Slice 6", index: 4, status: "draft" } } } }));

    // Step 2: chapter order updated to include the blank placeholder
    applyEvent(s, ev("slices-reordered", { chapterId: "c1", data: { newValue: { sliceIds: ["s1", "s2", "s3", "s4", "s-blank"] } } }));
    expect(s.chapters.get("c1")?.sliceOrder).toEqual(["s1", "s2", "s3", "s4", "s-blank"]);

    // Step 3: slices-moved — s1 moves to index 4, overriding s-blank
    applyEvent(s, ev("slices-moved", {
      chapterId: "c1",
      data: {
        sourceChapterId: "c1",
        targetChapterId: "c1",
        newValue: {
          slices: [
            {
              slice: { id: "s1", label: "Register Lead", index: 4, status: "draft", details: "", width: 250 },
              elements: [
                { id: "el1", name: "Register Lead", type: "command", sliceId: "s1" },
                { id: "el2", name: "Lead Registered", type: "event", sliceId: "s1" },
              ],
              newSliceId: "s1",
              oldSliceId: "s1",
            },
          ],
          overriddenSliceIds: ["s-blank"],
          removedSourceSlices: ["s1"],
          anchorSliceIndex: 4,
        },
        oldValue: {
          sourceSlices: [{ slice: { id: "s1", index: 0 }, elements: [] }],
          targetSlices: [{ id: "s-blank", index: 4 }],
        },
      },
    }));

    // s-blank must be gone — it was overridden/consumed
    expect(s.slices.has("s-blank")).toBe(false);

    // s1 must still exist with updated index
    expect(s.slices.has("s1")).toBe(true);
    expect(s.slices.get("s1")?.index).toBe(4);

    // sliceOrder must have s1 at the end (index 4), s-blank removed
    const order = s.chapters.get("c1")?.sliceOrder;
    expect(order).not.toContain("s-blank");
    expect(order).toContain("s1");
    // s1 should come after s2, s3, s4 (they are at indices 0-3, s1 is now at index 4)
    expect(order?.indexOf("s1")).toBeGreaterThan(order?.indexOf("s4") ?? -1);

    // elements belonging to s1 must still reference s1
    expect(s.elements.get("el1")?.sliceId).toBe("s1");
    expect(s.elements.get("el2")?.sliceId).toBe("s1");
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

  it("updates details on the element directly (no fan-out)", () => {
    const s = base();
    withElement(s, "el1", "Place Order");
    withElement(s, "el2", "Place Order"); // same name — no fan-out
    applyEvent(s, ev("element-details-changed", { elementId: "el1", data: { newValue: { details: "## body" } } }));
    expect(s.elements.get("el1")?.details).toBe("## body");
    expect(s.elements.get("el2")?.details).toBe(""); // not fanned out
  });

  it("element-details-synchronized updates details on the element directly", () => {
    const s = base();
    withElement(s, "el1", "Order");
    withElement(s, "el2", "Order");
    applyEvent(s, ev("element-details-synchronized", { elementId: "el2", data: { newValue: { details: "synced" } } }));
    expect(s.elements.get("el2")?.details).toBe("synced");
    expect(s.elements.get("el1")?.details).toBe(""); // not fanned out
  });

  it("rename just updates the element name", () => {
    const s = base();
    withElement(s, "el1", "Shared");
    withElement(s, "el2", "Shared");
    applyEvent(s, ev("element-renamed", { elementId: "el2", data: { newValue: { name: "Different" } } }));
    expect(s.elements.get("el2")?.name).toBe("Different");
    expect(s.elements.get("el1")?.name).toBe("Shared");
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

  it("tracks isTask on element comments (add, is_task, and update)", () => {
    const s = base();
    withElement(s, "el1", "X");
    applyEvent(s, ev("element-comment-added", { elementId: "el1", data: { newValue: { id: "c1", text: "task", isTask: true } } }));
    expect(s.elements.get("el1")?.comments[0].isTask).toBe(true);
    applyEvent(s, ev("element-comment-added", { elementId: "el1", data: { newValue: { id: "c2", text: "snake", is_task: true } } }));
    expect(s.elements.get("el1")?.comments[1].isTask).toBe(true);
    // update isTask without touching text
    applyEvent(s, ev("element-comment-updated", { elementId: "el1", data: { commentId: "c1", newValue: { isTask: false } } }));
    expect(s.elements.get("el1")?.comments[0].isTask).toBe(false);
    expect(s.elements.get("el1")?.comments[0].text).toBe("task"); // text preserved
  });

  it("element-comment-resolved removes the comment (task resolution == removal)", () => {
    const s = base();
    withElement(s, "el1", "X");
    applyEvent(s, ev("element-comment-added", { elementId: "el1", data: { newValue: { id: "c1", text: "task", isTask: true } } }));
    expect(s.elements.get("el1")?.comments).toHaveLength(1);
    // The board emits `element-comment-resolved` (not `-removed`) when a task comment is
    // resolved in the UI; carries the comment under oldValue.
    applyEvent(s, ev("element-comment-resolved", {
      elementId: "el1",
      data: { commentId: "c1", oldValue: { id: "c1", text: "task", isTask: true } },
    }));
    expect(s.elements.get("el1")?.comments).toHaveLength(0);
  });

  it("removing/resolving a comment schedules the entity comments dir for deletion", () => {
    const s = base();
    withElement(s, "el1", "X");
    applyEvent(s, ev("element-comment-added", { elementId: "el1", data: { newValue: { id: "c1", text: "a" } } }));

    const d = emptyDirtySet();
    applyEvent(s, ev("element-comment-removed", { elementId: "el1", data: { commentId: "c1" } }), d);
    // Partial writes never delete un-rendered files, so the removed comment's directory
    // must be pruned explicitly via dirsToDelete (writeTree removes it before re-writing).
    expect([...d.dirsToDelete]).toContain("chapters/c1/elements/el1/comments");

    // Slice counterpart via the resolve event.
    applyEvent(s, ev("new-slice-comment-written", { sliceId: "s1", data: { newValue: { comment: { id: "sc1", text: "x", isTask: true } } } }));
    const d2 = emptyDirtySet();
    applyEvent(s, ev("slice-comment-resolved", { sliceId: "s1", data: { newValue: { commentId: "sc1" } } }), d2);
    expect([...d2.dirsToDelete]).toContain("chapters/c1/slices/s1/comments");
  });

  it("does not schedule a deletion when the comment id is unknown (no churn)", () => {
    const s = base();
    withElement(s, "el1", "X");
    applyEvent(s, ev("element-comment-added", { elementId: "el1", data: { newValue: { id: "c1", text: "a" } } }));
    const d = emptyDirtySet();
    applyEvent(s, ev("element-comment-removed", { elementId: "el1", data: { commentId: "does-not-exist" } }), d);
    expect(d.dirsToDelete.size).toBe(0);
    expect(s.elements.get("el1")?.comments).toHaveLength(1);
  });

  it("accepts a numeric createdAt on live comment payloads", () => {
    const s = base();
    withElement(s, "el1", "X");
    // The board sends createdAt as a numeric ms-epoch on live events.
    applyEvent(s, ev("element-comment-added", { elementId: "el1", data: { newValue: { id: "c1", text: "n", createdAt: 1794221000742 } } }));
    expect(s.elements.get("el1")?.comments[0].createdAt).toBe("1794221000742");
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

  it("element-config-changed clears playFunction/playType on null", () => {
    const s = base();
    withElement(s, "el1", "Place Order");
    applyEvent(s, ev("element-config-changed", { elementId: "el1", data: { newValue: { playFunction: "fn()", playType: "type T = void" } } }));
    expect(s.elements.get("el1")?.playFunction).toBe("fn()");
    expect(s.elements.get("el1")?.playType).toBe("type T = void");

    // The board sends null when a play config field is cleared.
    applyEvent(s, ev("element-config-changed", { elementId: "el1", data: { newValue: { playFunction: null, playType: null } } }));
    expect(s.elements.get("el1")?.playFunction).toBeUndefined();
    expect(s.elements.get("el1")?.playType).toBeUndefined();
  });

  it("element-config-changed with unrelated keys leaves play config untouched", () => {
    const s = base();
    withElement(s, "el1", "Place Order");
    applyEvent(s, ev("element-config-changed", { elementId: "el1", data: { newValue: { playFunction: "fn()" } } }));
    applyEvent(s, ev("element-config-changed", { elementId: "el1", data: { newValue: { icon: "star" } } }));
    expect(s.elements.get("el1")?.playFunction).toBe("fn()");
    expect(s.elements.get("el1")?.icon).toBe("star");
  });

  it("element-config-synced clears playFunction/playType on null", () => {
    const s = base();
    withElement(s, "el1", "Ship Order");
    applyEvent(s, ev("element-config-synced", { elementId: "el1", data: { newValue: { playFunction: "fn()", playType: "type T = number" } } }));
    applyEvent(s, ev("element-config-synced", { elementId: "el1", data: { newValue: { playFunction: null } } }));
    expect(s.elements.get("el1")?.playFunction).toBeUndefined();
    expect(s.elements.get("el1")?.playType).toBe("type T = number"); // untouched
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

describe("scenario events", () => {
  const scenarioRaw = {
    id: "sc1",
    name: "Happy Path",
    clock: "2026-01-01T00:00:00Z",
    initial_state: { Ordering: { Cart: { items: [] } } },
    seeded_events: [{ name: "Order Placed", context: "Ordering", payload: { id: "o1" } }],
    interactions: [{ stepIndex: 0, storage: { key: "val" } }],
    created_at: "2026-10-01T00:00:00Z",
  };

  it("scenario-created inserts a scenario", () => {
    const s = base();
    applyEvent(s, ev("scenario-created", { chapterId: "c1", data: { scenarioId: "sc1", newValue: { scenario: scenarioRaw } } }));
    const sc = s.scenarios.get("sc1");
    expect(sc).toBeDefined();
    expect(sc!.name).toBe("Happy Path");
    expect(sc!.chapterId).toBe("c1");
    expect(sc!.clock).toBe("2026-01-01T00:00:00Z");
    expect(sc!.initialState).toEqual({ Ordering: { Cart: { items: [] } } });
    expect(sc!.seededEvents).toHaveLength(1);
    expect(sc!.seededEvents[0].name).toBe("Order Placed");
    expect(sc!.interactions).toHaveLength(1);
    expect(sc!.interactions[0].stepIndex).toBe(0);
    expect(sc!.createdAt).toBe("2026-10-01T00:00:00Z");
  });

  it("scenario-created is skipped without chapterId", () => {
    const s = base();
    applyEvent(s, ev("scenario-created", { chapterId: undefined, data: { scenarioId: "sc1", newValue: { scenario: scenarioRaw } } }));
    expect(s.scenarios.has("sc1")).toBe(false);
  });

  it("scenario-renamed updates the name", () => {
    const s = base();
    applyEvent(s, ev("scenario-created", { chapterId: "c1", data: { scenarioId: "sc1", newValue: { scenario: scenarioRaw } } }));
    applyEvent(s, ev("scenario-renamed", { chapterId: "c1", data: { scenarioId: "sc1", newValue: { id: "sc1", name: "Sad Path" } } }));
    expect(s.scenarios.get("sc1")!.name).toBe("Sad Path");
  });

  it("scenario-initial-state-changed replaces initialState and seededEvents", () => {
    const s = base();
    applyEvent(s, ev("scenario-created", { chapterId: "c1", data: { scenarioId: "sc1", newValue: { scenario: scenarioRaw } } }));
    const newState = { Ordering: { Cart: { items: ["x"] } } };
    const newEvents = [{ name: "Order Cancelled", context: "Ordering", payload: {} }];
    applyEvent(s, ev("scenario-initial-state-changed", {
      chapterId: "c1",
      data: { scenarioId: "sc1", newValue: { id: "sc1", initialState: newState, seededEvents: newEvents } },
    }));
    const sc = s.scenarios.get("sc1")!;
    expect(sc.initialState).toEqual(newState);
    expect(sc.seededEvents).toHaveLength(1);
    expect(sc.seededEvents[0].name).toBe("Order Cancelled");
  });

  it("scenario-clock-changed sets and clears clock", () => {
    const s = base();
    applyEvent(s, ev("scenario-created", { chapterId: "c1", data: { scenarioId: "sc1", newValue: { scenario: scenarioRaw } } }));
    applyEvent(s, ev("scenario-clock-changed", { chapterId: "c1", data: { scenarioId: "sc1", newValue: { id: "sc1", clock: "2027-06-01T12:00:00Z" } } }));
    expect(s.scenarios.get("sc1")!.clock).toBe("2027-06-01T12:00:00Z");
    // null clears the clock
    applyEvent(s, ev("scenario-clock-changed", { chapterId: "c1", data: { scenarioId: "sc1", newValue: { id: "sc1", clock: null } } }));
    expect(s.scenarios.get("sc1")!.clock).toBeUndefined();
  });

  it("scenario-interaction-recorded replaces all interactions when full array present", () => {
    const s = base();
    applyEvent(s, ev("scenario-created", { chapterId: "c1", data: { scenarioId: "sc1", newValue: { scenario: scenarioRaw } } }));
    const updated = [{ stepIndex: 0, storage: { a: 1 } }, { stepIndex: 1, storage: { b: 2 } }];
    applyEvent(s, ev("scenario-interaction-recorded", {
      chapterId: "c1",
      data: { scenarioId: "sc1", newValue: { id: "sc1", interactions: updated } },
    }));
    expect(s.scenarios.get("sc1")!.interactions).toHaveLength(2);
    expect(s.scenarios.get("sc1")!.interactions[1].stepIndex).toBe(1);
  });

  it("scenario-interaction-recorded upserts a single entry via nv.entry when no full array", () => {
    const s = base();
    applyEvent(s, ev("scenario-created", { chapterId: "c1", data: { scenarioId: "sc1", newValue: { scenario: { ...scenarioRaw, interactions: [] } } } }));
    applyEvent(s, ev("scenario-interaction-recorded", {
      chapterId: "c1",
      data: { scenarioId: "sc1", newValue: { id: "sc1", entry: { uiElementId: "ui-form", storage: { x: 9 } } } },
    }));
    expect(s.scenarios.get("sc1")!.interactions).toHaveLength(1);
    expect(s.scenarios.get("sc1")!.interactions[0]!.uiElementId).toBe("ui-form");
    // update the same UI element
    applyEvent(s, ev("scenario-interaction-recorded", {
      chapterId: "c1",
      data: { scenarioId: "sc1", newValue: { id: "sc1", entry: { uiElementId: "ui-form", storage: { x: 99 } } } },
    }));
    expect(s.scenarios.get("sc1")!.interactions).toHaveLength(1);
    expect(s.scenarios.get("sc1")!.interactions[0]!.storage).toEqual({ x: 99 });
  });

  it("scenario-deleted removes the scenario", () => {
    const s = base();
    applyEvent(s, ev("scenario-created", { chapterId: "c1", data: { scenarioId: "sc1", newValue: { scenario: scenarioRaw } } }));
    expect(s.scenarios.has("sc1")).toBe(true);
    applyEvent(s, ev("scenario-deleted", { chapterId: "c1", data: { scenarioId: "sc1" } }));
    expect(s.scenarios.has("sc1")).toBe(false);
  });

  it("scenario-deleted via oldValue.scenario.id fallback", () => {
    const s = base();
    applyEvent(s, ev("scenario-created", { chapterId: "c1", data: { scenarioId: "sc1", newValue: { scenario: scenarioRaw } } }));
    applyEvent(s, ev("scenario-deleted", { chapterId: "c1", data: { oldValue: { scenario: { id: "sc1", name: "Happy Path" } } } }));
    expect(s.scenarios.has("sc1")).toBe(false);
  });

  it("scenario events are no-ops for unknown scenario ids", () => {
    const s = base();
    expect(() => applyEvent(s, ev("scenario-renamed", { data: { scenarioId: "nope", newValue: { name: "x" } } }))).not.toThrow();
    expect(() => applyEvent(s, ev("scenario-clock-changed", { data: { scenarioId: "nope", newValue: { clock: "2026-01-01T00:00:00Z" } } }))).not.toThrow();
    expect(() => applyEvent(s, ev("scenario-interaction-recorded", { data: { scenarioId: "nope", newValue: {} } }))).not.toThrow();
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
