import { describe, it, expect } from "vitest";
import { seedModelFromData, seedModel } from "./seed.js";
import { applyEvent } from "./reducer.js";
import { emptyModel, elementDetailsKey } from "./model.js";
import { render } from "./render.js";
import type { ApiChapter, ApiMilestone, ApiScenario } from "./restClient.js";
import type { ChangelogEvent } from "../realtime/events.js";

function chapter(): ApiChapter {
  return {
    id: "c1",
    name: "Checkout",
    index: 0,
    context: "Ordering",
    mode: "event-modeling",
    lanes: [
      { id: "l2", label: "System", type: "system", index: 1, height: 150 },
      { id: "l1", label: "Customer", type: "user-lane", index: 0, height: 185 },
    ],
    slices: [
      { id: "s2", label: "Pay", index: 1, status: "draft" },
      { id: "s1", label: "Place Order", index: 0, status: "planned" },
    ],
    elements: [
      {
        id: "el1",
        type: "command",
        name: "Place Order",
        context: "Ordering",
        laneId: "l1",
        sliceId: "s1",
        index: 0,
        description: "Buy now",
        details: "## Behaviour",
        comments: [{ id: "cm1", text: "review this", author: "A", createdAt: "2026-01-01T00:00:00Z" }],
      },
      {
        id: "el2",
        type: "event",
        name: "Order Placed",
        context: "Ordering",
        laneId: "l2",
        sliceId: "s1",
        index: 0,
      },
    ],
  };
}

function milestone(): ApiMilestone {
  return {
    id: "m1",
    name: "MVP",
    description: "First release",
    slices: [{ slice_id: "s1", label: "Place Order", chapter_id: "c1", estimate: "3d" }],
  };
}

describe("seedModelFromData", () => {
  it("builds chapters, lanes, slices, elements", () => {
    const s = seedModelFromData("ws", "Demo", [chapter()], []);
    expect(s.chapters.get("c1")?.name).toBe("Checkout");
    expect(s.slices.size).toBe(2);
    expect(s.lanes.size).toBe(2);
    expect(s.elements.size).toBe(2);
  });

  it("preserves slice and lane order from index", () => {
    const s = seedModelFromData("ws", "Demo", [chapter()], []);
    expect(s.chapters.get("c1")?.sliceOrder).toEqual(["s1", "s2"]);
    expect(s.chapters.get("c1")?.laneOrder).toEqual(["l1", "l2"]);
  });

  it("seeds element description, shared details, and comments", () => {
    const s = seedModelFromData("ws", "Demo", [chapter()], []);
    expect(s.elements.get("el1")?.description).toBe("Buy now");
    expect(s.sharedElementDetails.get(elementDetailsKey("Ordering", "command", "Place Order"))?.body).toBe("## Behaviour");
    expect(s.elements.get("el1")?.comments[0].text).toBe("review this");
  });

  it("associates milestone slices and denormalizes estimate", () => {
    const s = seedModelFromData("ws", "Demo", [chapter()], [milestone()]);
    expect(s.milestones.get("m1")?.slices[0].sliceId).toBe("s1");
    expect(s.slices.get("s1")?.milestoneId).toBe("m1");
    expect(s.slices.get("s1")?.milestoneName).toBe("MVP");
    expect(s.slices.get("s1")?.estimate).toBe("3d");
  });

  it("produces a model that renders without error", () => {
    const s = seedModelFromData("ws", "Demo", [chapter()], [milestone()]);
    const tree = render(s);
    expect(tree.has("chapters/Ordering/c1_Checkout/chapter.json")).toBe(true);
    expect(tree.has("milestones/m1_MVP/milestone.json")).toBe(true);
  });

  it("matches a model built by replaying equivalent *-added events (rebuild parity)", () => {
    const seeded = seedModelFromData("ws", "Demo", [chapter()], [milestone()]);

    // Build the same model via the changelog path.
    const ev = (type: string, o: Partial<ChangelogEvent>): ChangelogEvent => ({
      id: "e", type, timestamp: 0, workspaceId: "ws", chapterId: "c1", userId: "u",
      addedByAgent: false, createdAt: "1970-01-01T00:00:00Z", data: {},
      row: {} as ChangelogEvent["row"], ...o,
    });
    const ch = chapter();
    const replayed = emptyModel("ws", "Demo");
    applyEvent(replayed, ev("chapter-added", { chapterId: "c1", context: "Ordering", data: { newValue: { id: "c1", name: "Checkout", mode: "event-modeling" } } }));
    applyEvent(replayed, ev("lane-added", { data: { newValue: { lane: ch.lanes[1] } } })); // l1 (index 0)
    applyEvent(replayed, ev("lane-added", { data: { newValue: { lane: ch.lanes[0] } } })); // l2 (index 1)
    applyEvent(replayed, ev("slice-added", { data: { newValue: { slice: ch.slices[1] } } })); // s1
    applyEvent(replayed, ev("slice-added", { data: { newValue: { slice: ch.slices[0] } } })); // s2
    applyEvent(replayed, ev("element-added", { data: { newValue: { element: ch.elements[0] } } }));
    applyEvent(replayed, ev("element-comment-added", { elementId: "el1", data: { newValue: ch.elements[0].comments![0] } }));
    applyEvent(replayed, ev("element-added", { data: { newValue: { element: ch.elements[1] } } }));
    applyEvent(replayed, ev("milestone-added", { chapterId: null, data: { newValue: { milestone: milestone() } } }));

    // The rendered trees must be identical (the strongest equality we care about).
    expect([...render(seeded).entries()].sort()).toEqual([...render(replayed).entries()].sort());
  });
});


function scenario(): ApiScenario {
  return {
    id: "sc1",
    chapter_id: "c1",
    name: "Happy Path",
    clock: "2026-01-01T00:00:00Z",
    initial_state: { Ordering: { Cart: { items: [] } } },
    seeded_events: [{ name: "Order Placed", context: "Ordering", payload: { id: "o1" } }],
    interactions: [{ stepIndex: 0, storage: { field: "val" } }],
    created_at: "2026-10-01T00:00:00Z",
  };
}

describe("seedModelFromData — scenarios", () => {
  it("seeds scenarios from the scenariosByChapter map", () => {
    const scenarios = new Map([["c1", [scenario()]]]);
    const s = seedModelFromData("ws", "Demo", [chapter()], [], scenarios);
    expect(s.scenarios.size).toBe(1);
    const sc = s.scenarios.get("sc1")!;
    expect(sc.name).toBe("Happy Path");
    expect(sc.chapterId).toBe("c1");
    expect(sc.clock).toBe("2026-01-01T00:00:00Z");
    expect(sc.initialState).toEqual({ Ordering: { Cart: { items: [] } } });
    expect(sc.seededEvents).toHaveLength(1);
    expect(sc.seededEvents[0].name).toBe("Order Placed");
    expect(sc.interactions).toHaveLength(1);
    expect(sc.interactions[0].stepIndex).toBe(0);
    expect(sc.createdAt).toBe("2026-10-01T00:00:00Z");
  });

  it("seeds an empty scenarios map when none exist", () => {
    const s = seedModelFromData("ws", "Demo", [chapter()], []);
    expect(s.scenarios.size).toBe(0);
  });

  it("renders scenario files for seeded scenarios", () => {
    const scenarios = new Map([["c1", [scenario()]]]);
    const s = seedModelFromData("ws", "Demo", [chapter()], [], scenarios);
    const t = render(s);
    expect(t.has("chapters/Ordering/c1_Checkout/scenarios/sc1_Happy-Path/scenario.json")).toBe(true);
  });

  it("seeds playFunction and playType from REST element data", () => {
    const ch = chapter();
    // Inject playFunction/playType onto an element as REST would return them
    (ch.elements[0] as Record<string, unknown>).playFunction = "async function play() {}";
    (ch.elements[0] as Record<string, unknown>).playType = "type T = void";
    const s = seedModelFromData("ws", "Demo", [ch], []);
    expect(s.elements.get("el1")?.playFunction).toBe("async function play() {}");
    expect(s.elements.get("el1")?.playType).toBe("type T = void");
  });
});

describe("seedModel (fetch orchestration)", () => {
  it("fetches summaries, each full chapter, milestones, and scenarios per chapter", async () => {
    const calls: string[] = [];
    const client = {
      async listChapters() {
        calls.push("listChapters");
        return [{ id: "c1", name: "Checkout", index: 0, context: "Ordering", mode: "event-modeling" }];
      },
      async getChapter(id: string) {
        calls.push(`getChapter:${id}`);
        return chapter();
      },
      async listMilestones() {
        calls.push("listMilestones");
        return [milestone()];
      },
      async listScenarios(chapterId: string) {
        calls.push(`listScenarios:${chapterId}`);
        return [scenario()];
      },
    };
    const s = await seedModel(client as unknown as import("./restClient.js").RestClient, "ws", "Demo");
    expect(calls).toContain("listChapters");
    expect(calls).toContain("getChapter:c1");
    expect(calls).toContain("listMilestones");
    expect(calls).toContain("listScenarios:c1");
    expect(s.chapters.size).toBe(1);
    expect(s.milestones.size).toBe(1);
    expect(s.scenarios.size).toBe(1);
  });
});
