import { describe, it, expect } from "vitest";
import { render } from "./render.js";
import { applyEvent } from "./reducer.js";
import { emptyModel, type ModelState } from "./model.js";
import type { ChangelogEvent } from "../realtime/events.js";

function ev(type: string, overrides: Partial<ChangelogEvent> = {}): ChangelogEvent {
  return {
    id: "e",
    type,
    timestamp: 1,
    workspaceId: "ws",
    chapterId: "c1",
    chapterName: "Chapter",
    userId: "u",
    addedByAgent: false,
    createdAt: "2026-10-03T00:00:00Z",
    data: {},
    row: {} as ChangelogEvent["row"],
    ...overrides,
  };
}

function model(): ModelState {
  const s = emptyModel("ws", "Demo Workspace");
  applyEvent(s, ev("chapter-added", { chapterId: "c1", context: "Ordering", data: { newValue: { id: "c1", name: "Checkout", mode: "event-modeling" } } }));
  applyEvent(s, ev("slice-added", { chapterId: "c1", data: { newValue: { slice: { id: "s1", label: "Place Order", index: 0, status: "planned" } } } }));
  applyEvent(s, ev("lane-added", { chapterId: "c1", data: { newValue: { lane: { id: "l1", label: "Customer", type: "user-lane", index: 0 } } } }));
  applyEvent(s, ev("element-added", { chapterId: "c1", data: { newValue: { element: { id: "el1", type: "command", name: "Place Order", context: "Ordering", laneId: "l1", sliceId: "s1", index: 0, description: "Click buy" } } } }));
  return s;
}

// New UUID-based paths
const CHAPTER_DIR = "chapters/c1";
const SLICE_DIR   = `${CHAPTER_DIR}/slices/s1`;
const LANE_DIR    = `${CHAPTER_DIR}/lanes/l1`;
const ELEMENT_DIR = `${CHAPTER_DIR}/elements/el1`;

describe("render layout", () => {
  it("writes workspace.json", () => {
    const t = render(model());
    expect(t.has("workspace.json")).toBe(true);
    expect(JSON.parse(t.get("workspace.json")!).name).toBe("Demo Workspace");
  });

  it("places chapter under chapters/[uuid]/ (UUID-keyed, no context/slug prefix)", () => {
    const t = render(model());
    expect(t.has(`${CHAPTER_DIR}/chapter.json`)).toBe(true);
    expect(t.has(`${CHAPTER_DIR}/index.md`)).toBe(true);
  });

  it("places slice flat under chapters/[uuid]/slices/[uuid]/", () => {
    const t = render(model());
    expect(t.has(`${SLICE_DIR}/slice.json`)).toBe(true);
  });

  it("places lane flat under chapters/[uuid]/lanes/[uuid]/ and element under chapters/[uuid]/elements/[uuid]/", () => {
    const t = render(model());
    expect(t.has(`${LANE_DIR}/lane.json`)).toBe(true);
    expect(t.has(`${ELEMENT_DIR}/element.json`)).toBe(true);
    expect(t.has(`${ELEMENT_DIR}/description.md`)).toBe(true);
  });

  it("element description.md carries the content", () => {
    const t = render(model());
    const md = t.get(`${ELEMENT_DIR}/description.md`)!;
    expect(md).toContain("Click buy");
  });

  it("always materializes lane folders even when the lane has no elements", () => {
    const s = model();
    applyEvent(s, ev("lane-added", { chapterId: "c1", data: { newValue: { lane: { id: "l2", label: "System", type: "system", index: 1 } } } }));
    const t = render(s);
    const laneJson = `${CHAPTER_DIR}/lanes/l2/lane.json`;
    expect(t.has(laneJson)).toBe(true);
    const lane = JSON.parse(t.get(laneJson)!);
    expect(lane.id).toBe("l2");
  });

  it("does not emit play-function.ts or play-type.ts when not set", () => {
    const t = render(model());
    expect(t.has(`${ELEMENT_DIR}/play-function.ts`)).toBe(false);
    expect(t.has(`${ELEMENT_DIR}/play-type.ts`)).toBe(false);
    const el = JSON.parse(t.get(`${ELEMENT_DIR}/element.json`)!);
    expect(el).not.toHaveProperty("playFunctionRef");
    expect(el).not.toHaveProperty("playTypeRef");
  });

  it("emits play-function.ts when playFunction is set", () => {
    const s = model();
    applyEvent(s, ev("element-config-changed", { elementId: "el1", data: { newValue: { playFunction: "async function play() { return 1; }" } } }));
    const t = render(s);
    expect(t.get(`${ELEMENT_DIR}/play-function.ts`)).toBe("async function play() { return 1; }");
    const el = JSON.parse(t.get(`${ELEMENT_DIR}/element.json`)!);
    expect(el).not.toHaveProperty("playFunctionRef");
    expect(el).not.toHaveProperty("playTypeRef");
  });

  it("emits play-type.ts when playType is set", () => {
    const s = model();
    applyEvent(s, ev("element-config-changed", { elementId: "el1", data: { newValue: { playType: "type Input = { id: string }" } } }));
    const t = render(s);
    expect(t.get(`${ELEMENT_DIR}/play-type.ts`)).toBe("type Payload = type Input = { id: string }");
    const el = JSON.parse(t.get(`${ELEMENT_DIR}/element.json`)!);
    expect(el).not.toHaveProperty("playFunctionRef");
    expect(el).not.toHaveProperty("playTypeRef");
  });

  it("emits both play-function.ts and play-type.ts when both are set", () => {
    const s = model();
    applyEvent(s, ev("element-config-synced", { elementId: "el1", data: { newValue: { playFunction: "fn()", playType: "type T = void" } } }));
    const t = render(s);
    expect(t.get(`${ELEMENT_DIR}/play-function.ts`)).toBe("fn()");
    expect(t.get(`${ELEMENT_DIR}/play-type.ts`)).toBe("type Payload = type T = void");
    const el = JSON.parse(t.get(`${ELEMENT_DIR}/element.json`)!);
    expect(el).not.toHaveProperty("playFunctionRef");
    expect(el).not.toHaveProperty("playTypeRef");
  });

  it("emits uuid-index.json mapping entity ids to their directory paths", () => {
    const t = render(model());
    expect(t.has("uuid-index.json")).toBe(true);
    const index = JSON.parse(t.get("uuid-index.json")!);
    expect(index["c1"]).toBe(CHAPTER_DIR);
    expect(index["s1"]).toBe(SLICE_DIR);
    expect(index["l1"]).toBe(LANE_DIR);
    expect(index["el1"]).toBe(ELEMENT_DIR);
  });

  it("indexes an empty lane's id in uuid-index.json", () => {
    const s = model();
    applyEvent(s, ev("lane-added", { chapterId: "c1", data: { newValue: { lane: { id: "l2", label: "System", type: "system", index: 1 } } } }));
    const t = render(s);
    const index = JSON.parse(t.get("uuid-index.json")!);
    expect(index["l2"]).toBe(`${CHAPTER_DIR}/lanes/l2`);
  });
});

describe("shared details", () => {
  it("does not write element-details/ canonical tree", () => {
    const s = model();
    applyEvent(s, ev("element-details-changed", { elementId: "el1", data: { newValue: { details: "## Behaviour" } } }));
    const t = render(s);
    expect([...t.keys()].some((k) => k.startsWith("element-details/"))).toBe(false);
  });

  it("writes lane-details only when a body exists", () => {
    const s = model();
    let t = render(s);
    expect([...t.keys()].some((k) => k.startsWith("lane-details/"))).toBe(false);
    applyEvent(s, ev("lane-details-changed", { data: { laneId: "l1", newValue: { details: "lane spec" } } }));
    t = render(s);
    expect(t.get("lane-details/user-lane/Customer/details.md")).toContain("lane spec");
  });
});

describe("milestones and comments", () => {
  it("renders a milestone with description", () => {
    const s = model();
    applyEvent(s, ev("milestone-added", { data: { newValue: { milestone: { id: "m1", name: "MVP", description: "First release", slices: [] } } } }));
    const t = render(s);
    expect(t.has("milestones/m1/milestone.json")).toBe(true);
    expect(t.get("milestones/m1/description.md")).toContain("First release");
  });

  it("renders element comments as json + md", () => {
    const s = model();
    applyEvent(s, ev("element-comment-added", { elementId: "el1", data: { newValue: { id: "cm1", text: "needs review", author: "Alex", createdAt: "2026-04-30T14:19:11Z" } } }));
    const t = render(s);
    const dir = `${ELEMENT_DIR}/comments`;
    const key = [...t.keys()].find((k) => k.startsWith(dir) && k.endsWith("comment.md"));
    expect(key).toBeTruthy();
    expect(t.get(key!)).toContain("needs review");
  });

  it("renders isTask into comment.json when the comment is a task", () => {
    const s = model();
    applyEvent(s, ev("element-comment-added", { elementId: "el1", data: { newValue: { id: "cm1", text: "do this", createdAt: "2026-04-30T14:19:11Z", isTask: true } } }));
    const t = render(s);
    const dir = `${ELEMENT_DIR}/comments`;
    const jsonKey = [...t.keys()].find((k) => k.startsWith(dir) && k.endsWith("comment.json"));
    expect(jsonKey).toBeTruthy();
    expect(JSON.parse(t.get(jsonKey!)!).isTask).toBe(true);
  });

  it("omits isTask from comment.json for non-task comments", () => {
    const s = model();
    applyEvent(s, ev("element-comment-added", { elementId: "el1", data: { newValue: { id: "cm1", text: "fyi", createdAt: "2026-04-30T14:19:11Z" } } }));
    const t = render(s);
    const dir = `${ELEMENT_DIR}/comments`;
    const jsonKey = [...t.keys()].find((k) => k.startsWith(dir) && k.endsWith("comment.json"));
    expect("isTask" in JSON.parse(t.get(jsonKey!)!)).toBe(false);
  });
});

describe("sanitization and robustness", () => {
  it("sanitizes unsafe names in context/name only in lane-details; chapter dir is UUID only", () => {
    const s = emptyModel("ws", "WS");
    applyEvent(s, ev("chapter-added", { chapterId: "c1", context: "A/B", data: { newValue: { id: "c1", name: "Hello: World?" } } }));
    const t = render(s);
    // Chapter dir is just the UUID — no context or name slug
    const path = [...t.keys()].find((k) => k.endsWith("chapter.json"))!;
    expect(path).toBe("chapters/c1/chapter.json");
    expect(JSON.parse(t.get(path)!).name).toBe("Hello: World?"); // raw preserved in json
    expect(JSON.parse(t.get(path)!).context).toBe("A/B");
  });

  it("is fully deterministic for the same state", () => {
    const a = render(model());
    const b = render(model());
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const k of a.keys()) {
      expect(b.get(k)).toBe(a.get(k));
    }
  });

  it("JSON omits undefined fields", () => {
    const t = render(model());
    const sliceJson = t.get(`${SLICE_DIR}/slice.json`)!;
    expect(sliceJson).not.toContain("assignee");
    expect(JSON.parse(sliceJson).status).toBe("planned");
  });
});

describe("scenarios", () => {
  it("renders no scenarios dir when chapter has none", () => {
    const t = render(model());
    expect([...t.keys()].some((k) => k.includes("/scenarios/"))).toBe(false);
  });

  it("renders scenario.json under chapters/[uuid]/scenarios/[scenario-uuid]/", () => {
    const s = model();
    applyEvent(s, ev("scenario-created", {
      chapterId: "c1",
      data: {
        scenarioId: "sc1",
        newValue: {
          scenario: {
            id: "sc1",
            name: "Happy Path",
            clock: "2026-01-01T00:00:00Z",
            initial_state: { Ordering: { Cart: {} } },
            seeded_events: [{ name: "Order Placed", context: "Ordering", payload: { id: "o1" } }],
            interactions: [],
            created_at: "2026-10-01T00:00:00Z",
          },
        },
      },
    }));
    const t = render(s);
    const path = `${CHAPTER_DIR}/scenarios/sc1/scenario.json`;
    expect(t.has(path)).toBe(true);
    const sc = JSON.parse(t.get(path)!);
    expect(sc.id).toBe("sc1");
    expect(sc.name).toBe("Happy Path");
    expect(sc.clock).toBe("2026-01-01T00:00:00Z");
    expect(sc.chapterId).toBe("c1");
    expect(sc.createdAt).toBe("2026-10-01T00:00:00Z");
    expect(sc.initialState).toEqual({ Ordering: { Cart: {} } });
    expect(sc.seededEvents).toHaveLength(1);
  });

  it("omits empty initialState, seededEvents, and interactions from scenario.json", () => {
    const s = model();
    applyEvent(s, ev("scenario-created", {
      chapterId: "c1",
      data: {
        scenarioId: "sc2",
        newValue: {
          scenario: { id: "sc2", name: "Empty", initial_state: {}, seeded_events: [], interactions: [] },
        },
      },
    }));
    const t = render(s);
    const sc = JSON.parse(t.get(`${CHAPTER_DIR}/scenarios/sc2/scenario.json`)!);
    expect(sc.initialState).toBeUndefined();
    expect(sc.seededEvents).toBeUndefined();
    expect(sc.interactions).toBeUndefined();
  });

  it("renders interactions when present", () => {
    const s = model();
    applyEvent(s, ev("scenario-created", {
      chapterId: "c1",
      data: {
        scenarioId: "sc3",
        newValue: {
          scenario: {
            id: "sc3",
            name: "With Interactions",
            initial_state: {},
            seeded_events: [],
            interactions: [{ stepIndex: 0, storage: { field: "value" } }],
          },
        },
      },
    }));
    const t = render(s);
    const sc = JSON.parse(t.get(`${CHAPTER_DIR}/scenarios/sc3/scenario.json`)!);
    expect(sc.interactions).toHaveLength(1);
    expect(sc.interactions[0].stepIndex).toBe(0);
  });

  it("scenario dir is removed after scenario-deleted", () => {
    const s = model();
    applyEvent(s, ev("scenario-created", {
      chapterId: "c1",
      data: { scenarioId: "sc4", newValue: { scenario: { id: "sc4", name: "Temp", initial_state: {}, seeded_events: [], interactions: [] } } },
    }));
    let t = render(s);
    expect(t.has(`${CHAPTER_DIR}/scenarios/sc4/scenario.json`)).toBe(true);

    applyEvent(s, ev("scenario-deleted", { chapterId: "c1", data: { scenarioId: "sc4" } }));
    t = render(s);
    expect([...t.keys()].some((k) => k.includes("/sc4/"))).toBe(false);
  });

  it("scenario dir stays the same after scenario-renamed (UUID-keyed, name only changes in JSON)", () => {
    const s = model();
    applyEvent(s, ev("scenario-created", {
      chapterId: "c1",
      data: { scenarioId: "sc5", newValue: { scenario: { id: "sc5", name: "Old Name", initial_state: {}, seeded_events: [], interactions: [] } } },
    }));
    applyEvent(s, ev("scenario-renamed", { chapterId: "c1", data: { scenarioId: "sc5", newValue: { id: "sc5", name: "New Name" } } }));
    const t = render(s);
    // Dir stays sc5 — UUID is immutable; name change is in the JSON only
    expect(t.has(`${CHAPTER_DIR}/scenarios/sc5/scenario.json`)).toBe(true);
    const sc = JSON.parse(t.get(`${CHAPTER_DIR}/scenarios/sc5/scenario.json`)!);
    expect(sc.name).toBe("New Name");
  });
});

// ─── renderPartial ───────────────────────────────────────────────────────────

import { renderPartial } from "./render.js";
import { emptyDirtySet } from "./reducer.js";

describe("renderPartial", () => {
  it("always includes workspace.json and uuid-index.json", () => {
    const { tree: t } = renderPartial(model(), emptyDirtySet());
    expect(t.has("workspace.json")).toBe(true);
    expect(t.has("uuid-index.json")).toBe(true);
  });

  it("does NOT include entity files for clean entities", () => {
    // Only lane-resized is dirty — element files should not appear
    const dirty = emptyDirtySet();
    dirty.lanes.add("l1");
    const { tree: t } = renderPartial(model(), dirty);
    expect(t.has(`${ELEMENT_DIR}/element.json`)).toBe(false);
    expect(t.has(`${ELEMENT_DIR}/description.md`)).toBe(false);
    expect(t.has(`${SLICE_DIR}/slice.json`)).toBe(false);
  });

  it("includes only the dirty lane's files", () => {
    const dirty = emptyDirtySet();
    dirty.lanes.add("l1");
    const { tree: t } = renderPartial(model(), dirty);
    expect(t.has(`${LANE_DIR}/lane.json`)).toBe(true);
  });

  it("includes dirty element files but not sibling elements", () => {
    const s = model();
    // Add a second element
    applyEvent(s, ev("element-added", { chapterId: "c1", data: { newValue: { element: { id: "el2", type: "event", name: "Order Placed", context: "Ordering", laneId: "l1", sliceId: "s1", index: 1 } } } }));
    const dirty = emptyDirtySet();
    dirty.elements.add("el1"); // only el1 is dirty
    const { tree: t } = renderPartial(s, dirty);
    expect(t.has(`${ELEMENT_DIR}/element.json`)).toBe(true);
    expect(t.has(`${CHAPTER_DIR}/elements/el2/element.json`)).toBe(false);
  });

  it("regenerates chapter index.md and chapter.json when a slice is dirty (child change)", () => {
    const dirty = emptyDirtySet();
    dirty.slices.add("s1");
    const { tree: t } = renderPartial(model(), dirty);
    expect(t.has(`${CHAPTER_DIR}/index.md`)).toBe(true);
    // chapter.json is also re-emitted alongside index.md to keep the dir consistent
    expect(t.has(`${CHAPTER_DIR}/chapter.json`)).toBe(true);
  });

  it("renders full chapter subtree when chapter itself is dirty", () => {
    const dirty = emptyDirtySet();
    dirty.chapters.add("c1");
    const { tree: t } = renderPartial(model(), dirty);
    expect(t.has(`${CHAPTER_DIR}/chapter.json`)).toBe(true);
    expect(t.has(`${CHAPTER_DIR}/index.md`)).toBe(true);
    expect(t.has(`${SLICE_DIR}/slice.json`)).toBe(true);
    expect(t.has(`${LANE_DIR}/lane.json`)).toBe(true);
    expect(t.has(`${ELEMENT_DIR}/element.json`)).toBe(true);
  });

  it("matches full render output for the dirty entities", () => {
    const s = model();
    const dirty = emptyDirtySet();
    dirty.elements.add("el1");
    const { tree: partial } = renderPartial(s, dirty);
    const full = render(s);
    // The element files should be identical between partial and full render
    for (const path of [`${ELEMENT_DIR}/element.json`, `${ELEMENT_DIR}/description.md`, `${ELEMENT_DIR}/details.md`]) {
      expect(partial.get(path)).toBe(full.get(path));
    }
  });

  it("returns dirsToDelete for a deleted chapter", () => {
    const s = model();
    // Delete the chapter from state
    applyEvent(s, ev("chapter-removed", { chapterId: "c1", data: { id: "c1" } }));
    const dirty = emptyDirtySet();
    dirty.chapters.add("c1");
    const { dirsToDelete } = renderPartial(s, dirty);
    expect(dirsToDelete.has(`chapters/c1`)).toBe(true);
  });

  it("returns dirsToDelete for a deleted milestone", () => {
    const s = model();
    applyEvent(s, ev("milestone-added", { data: { newValue: { milestone: { id: "m1", name: "MVP", description: "", slices: [] } } } }));
    applyEvent(s, ev("milestone-deleted", { data: { milestoneId: "m1" } }));
    const dirty = emptyDirtySet();
    dirty.milestones.add("m1");
    const { dirsToDelete } = renderPartial(s, dirty);
    expect(dirsToDelete.has("milestones/m1")).toBe(true);
  });
});
