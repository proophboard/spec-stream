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

describe("render layout", () => {
  it("writes workspace.json", () => {
    const t = render(model());
    expect(t.has("workspace.json")).toBe(true);
    expect(JSON.parse(t.get("workspace.json")!).name).toBe("Demo Workspace");
  });

  it("places chapter under context with slug-only dir (no UUID)", () => {
    const t = render(model());
    expect(t.has("chapters/Ordering/Checkout/chapter.json")).toBe(true);
    expect(t.has("chapters/Ordering/Checkout/index.md")).toBe(true);
  });

  it("nests slice with ordered prefix (no UUID)", () => {
    const t = render(model());
    expect(t.has("chapters/Ordering/Checkout/slices/0000_Place-Order/slice.json")).toBe(true);
  });

  it("nests lane under slice and element under lane (slice-first)", () => {
    const t = render(model());
    const base =
      "chapters/Ordering/Checkout/slices/0000_Place-Order/lanes/user-lane/Customer";
    expect(t.has(`${base}/lane.json`)).toBe(true);
    expect(t.has(`${base}/elements/0000_Place-Order/element.json`)).toBe(true);
    expect(t.has(`${base}/elements/0000_Place-Order/description.md`)).toBe(true);
  });

  it("element description.md carries the content and generated marker", () => {
    const t = render(model());
    const md = t.get(
      "chapters/Ordering/Checkout/slices/0000_Place-Order/lanes/user-lane/Customer/elements/0000_Place-Order/description.md",
    )!;
    expect(md).toContain("Click buy");
    expect(md).toContain("NOT synced back");
  });

  it("does not materialize empty lanes under a slice", () => {
    const s = model();
    // add a second lane with no elements in s1
    applyEvent(s, ev("lane-added", { chapterId: "c1", data: { newValue: { lane: { id: "l2", label: "System", type: "system", index: 1 } } } }));
    const t = render(s);
    const empty = [...t.keys()].some((k) => k.includes("System"));
    expect(empty).toBe(false);
  });

  it("element.json has a detailsRef into the canonical tree", () => {
    const t = render(model());
    const el = JSON.parse(
      t.get(
        "chapters/Ordering/Checkout/slices/0000_Place-Order/lanes/user-lane/Customer/elements/0000_Place-Order/element.json",
      )!,
    );
    expect(el.detailsRef).toBe("element-details/Ordering/command/Place-Order/details.md");
  });

  it("does not emit play-function.ts or play-type.ts when not set", () => {
    const t = render(model());
    const dir = "chapters/Ordering/Checkout/slices/0000_Place-Order/lanes/user-lane/Customer/elements/0000_Place-Order";
    expect(t.has(`${dir}/play-function.ts`)).toBe(false);
    expect(t.has(`${dir}/play-type.ts`)).toBe(false);
    const el = JSON.parse(t.get(`${dir}/element.json`)!);
    expect(el.playFunctionRef).toBeUndefined();
    expect(el.playTypeRef).toBeUndefined();
  });

  it("emits play-function.ts when playFunction is set", () => {
    const s = model();
    applyEvent(s, ev("element-config-changed", { elementId: "el1", data: { newValue: { playFunction: "async function play() { return 1; }" } } }));
    const t = render(s);
    const dir = "chapters/Ordering/Checkout/slices/0000_Place-Order/lanes/user-lane/Customer/elements/0000_Place-Order";
    expect(t.get(`${dir}/play-function.ts`)).toBe("async function play() { return 1; }");
    const el = JSON.parse(t.get(`${dir}/element.json`)!);
    expect(el.playFunctionRef).toBe(`${dir}/play-function.ts`);
    expect(el.playTypeRef).toBeUndefined();
  });

  it("emits play-type.ts when playType is set", () => {
    const s = model();
    applyEvent(s, ev("element-config-changed", { elementId: "el1", data: { newValue: { playType: "type Input = { id: string }" } } }));
    const t = render(s);
    const dir = "chapters/Ordering/Checkout/slices/0000_Place-Order/lanes/user-lane/Customer/elements/0000_Place-Order";
    expect(t.get(`${dir}/play-type.ts`)).toBe("type Payload = type Input = { id: string }");
    const el = JSON.parse(t.get(`${dir}/element.json`)!);
    expect(el.playTypeRef).toBe(`${dir}/play-type.ts`);
    expect(el.playFunctionRef).toBeUndefined();
  });

  it("emits both play-function.ts and play-type.ts when both are set", () => {
    const s = model();
    applyEvent(s, ev("element-config-synced", { elementId: "el1", data: { newValue: { playFunction: "fn()", playType: "type T = void" } } }));
    const t = render(s);
    const dir = "chapters/Ordering/Checkout/slices/0000_Place-Order/lanes/user-lane/Customer/elements/0000_Place-Order";
    expect(t.get(`${dir}/play-function.ts`)).toBe("fn()");
    expect(t.get(`${dir}/play-type.ts`)).toBe("type Payload = type T = void");
    const el = JSON.parse(t.get(`${dir}/element.json`)!);
    expect(el.playFunctionRef).toBe(`${dir}/play-function.ts`);
    expect(el.playTypeRef).toBe(`${dir}/play-type.ts`);
  });

  it("emits uuid-index.json mapping entity ids to their directory paths", () => {
    const t = render(model());
    expect(t.has("uuid-index.json")).toBe(true);
    const index = JSON.parse(t.get("uuid-index.json")!);
    expect(index["c1"]).toBe("chapters/Ordering/Checkout");
    expect(index["s1"]).toBe("chapters/Ordering/Checkout/slices/0000_Place-Order");
    expect(index["l1"]).toBe("chapters/Ordering/Checkout/slices/0000_Place-Order/lanes/user-lane/Customer");
    expect(index["el1"]).toBe("chapters/Ordering/Checkout/slices/0000_Place-Order/lanes/user-lane/Customer/elements/0000_Place-Order");
  });
});

describe("shared details", () => {
  it("writes canonical element-details once per group", () => {
    const s = model();
    applyEvent(s, ev("element-details-changed", { elementId: "el1", data: { newValue: { details: "## Behaviour" } } }));
    const t = render(s);
    const path = "element-details/Ordering/command/Place-Order/details.md";
    expect(t.get(path)).toContain("## Behaviour");
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
    expect(t.has("milestones/MVP/milestone.json")).toBe(true);
    expect(t.get("milestones/MVP/description.md")).toContain("First release");
  });

  it("renders element comments as json + md", () => {
    const s = model();
    applyEvent(s, ev("element-comment-added", { elementId: "el1", data: { newValue: { id: "cm1", text: "needs review", author: "Alex", createdAt: "2026-04-30T14:19:11Z" } } }));
    const t = render(s);
    const dir = "chapters/Ordering/Checkout/slices/0000_Place-Order/lanes/user-lane/Customer/elements/0000_Place-Order/comments";
    const key = [...t.keys()].find((k) => k.startsWith(dir) && k.endsWith("comment.md"));
    expect(key).toBeTruthy();
    expect(t.get(key!)).toContain("needs review");
  });
});

describe("sanitization and robustness", () => {
  it("sanitizes unsafe names in paths but keeps raw in json", () => {
    const s = emptyModel("ws", "WS");
    applyEvent(s, ev("chapter-added", { chapterId: "c1", context: "A/B", data: { newValue: { id: "c1", name: "Hello: World?" } } }));
    const t = render(s);
    const path = [...t.keys()].find((k) => k.endsWith("chapter.json"))!;
    expect(path).toContain("A-B");
    expect(path).toContain("Hello-World");
    expect(path).not.toMatch(/c1_Hello/); // no UUID in path
    expect(JSON.parse(t.get(path)!).name).toBe("Hello: World?"); // raw preserved
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
    const sliceJson = t.get(
      "chapters/Ordering/Checkout/slices/0000_Place-Order/slice.json",
    )!;
    expect(sliceJson).not.toContain("assignee");
    expect(JSON.parse(sliceJson).status).toBe("planned");
  });
});

describe("scenarios", () => {
  it("renders no scenarios dir when chapter has none", () => {
    const t = render(model());
    expect([...t.keys()].some((k) => k.includes("/scenarios/"))).toBe(false);
  });

  it("renders scenario.json under chapters/.../scenarios/[name]/", () => {
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
    const path = "chapters/Ordering/Checkout/scenarios/Happy-Path/scenario.json";
    expect(t.has(path)).toBe(true);
    const sc = JSON.parse(t.get(path)!);
    expect(sc.id).toBe("sc1");
    expect(sc.name).toBe("Happy Path");
    expect(sc.clock).toBe("2026-01-01T00:00:00Z");
    expect(sc.chapterId).toBe("c1");
    expect(sc.createdAt).toBe("2026-10-01T00:00:00Z");
    // Non-empty initialState is serialised
    expect(sc.initialState).toEqual({ Ordering: { Cart: {} } });
    // Non-empty seededEvents is serialised
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
    const sc = JSON.parse(t.get("chapters/Ordering/Checkout/scenarios/Empty/scenario.json")!);
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
    const sc = JSON.parse(t.get("chapters/Ordering/Checkout/scenarios/With-Interactions/scenario.json")!);
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
    expect(t.has("chapters/Ordering/Checkout/scenarios/Temp/scenario.json")).toBe(true);

    applyEvent(s, ev("scenario-deleted", { chapterId: "c1", data: { scenarioId: "sc4" } }));
    t = render(s);
    expect([...t.keys()].some((k) => k.includes("/Temp/"))).toBe(false);
  });

  it("scenario dir is renamed after scenario-renamed", () => {
    const s = model();
    applyEvent(s, ev("scenario-created", {
      chapterId: "c1",
      data: { scenarioId: "sc5", newValue: { scenario: { id: "sc5", name: "Old Name", initial_state: {}, seeded_events: [], interactions: [] } } },
    }));
    applyEvent(s, ev("scenario-renamed", { chapterId: "c1", data: { scenarioId: "sc5", newValue: { id: "sc5", name: "New Name" } } }));
    const t = render(s);
    expect(t.has("chapters/Ordering/Checkout/scenarios/New-Name/scenario.json")).toBe(true);
    expect([...t.keys()].some((k) => k.includes("Old-Name"))).toBe(false);
  });
});
