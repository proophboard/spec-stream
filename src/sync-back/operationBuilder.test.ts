import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildOperations, PENDING_ELEMENT_ID, PENDING_SCENARIO_ID } from "./operationBuilder.js";
import type { EntityDiff } from "./manifestDiff.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRoot(): string {
  const dir = join(tmpdir(), `spec-stream-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(root: string, relPath: string, data: unknown): void {
  const abs = join(root, relPath);
  mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  writeFileSync(abs, JSON.stringify(data, null, 2), "utf8");
}

function writeFile(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

const CHAPTER_ID = "chapter-uuid-1";
const SLICE_ID   = "slice-uuid-1";
const LANE_ID    = "lane-uuid-1";
const ELEMENT_ID = "element-uuid-1";
const MILESTONE_ID = "milestone-uuid-1";

const CHAPTER_DIR  = `chapters/${CHAPTER_ID}`;
const SLICE_DIR    = `${CHAPTER_DIR}/slices/${SLICE_ID}`;
const LANE_DIR     = `${CHAPTER_DIR}/lanes/${LANE_ID}`;
const ELEMENT_DIR  = `${CHAPTER_DIR}/elements/${ELEMENT_ID}`;
const MILESTONE_DIR = `milestones/${MILESTONE_ID}`;

function setupChapter(root: string): void {
  writeJson(root, `${CHAPTER_DIR}/chapter.json`, {
    id: CHAPTER_ID, name: "My Chapter", context: "App", mode: "event-modeling", index: 0,
  });
}

function setupSlice(root: string): void {
  setupChapter(root);
  writeJson(root, `${SLICE_DIR}/slice.json`, {
    id: SLICE_ID, label: "My Slice", index: 0, status: "draft",
  });
  writeFile(root, `${SLICE_DIR}/details.md`, "Some slice details");
}

function setupLane(root: string): void {
  setupSlice(root);
  writeJson(root, `${LANE_DIR}/lane.json`, {
    id: LANE_ID, label: "My Lane", type: "information-flow", index: 0, height: 150,
  });
}

function setupElement(root: string): void {
  setupLane(root);
  writeJson(root, `${ELEMENT_DIR}/element.json`, {
    id: ELEMENT_ID, type: "command", name: "My Element", context: "App",
    laneId: LANE_ID, sliceId: SLICE_ID, index: 0,
  });
  writeFile(root, `${ELEMENT_DIR}/description.md`, "Do something");
  writeFile(root, `${ELEMENT_DIR}/details.md`, "Detailed notes");
}

function setupMilestone(root: string): void {
  writeJson(root, `${MILESTONE_DIR}/milestone.json`, {
    id: MILESTONE_ID, name: "My Milestone", deadline: "2026-12-31", color: "#3b82f6",
  });
  writeFile(root, `${MILESTONE_DIR}/description.md`, "Milestone description");
}

// ─── Diff factory helpers ─────────────────────────────────────────────────────
// These replace the old FileChange factory. Tests express intent at the entity
// level (create/update/delete/rename) rather than at the git-diff file level.

function createDiff(entityDir: string, kind: EntityDiff["kind"]): EntityDiff {
  return { status: "create", entityDir, kind };
}

function updateDiff(entityDir: string, kind: EntityDiff["kind"], id: string, extra?: Partial<EntityDiff>): EntityDiff {
  return { status: "update", entityDir, kind, id, ...extra };
}

function deleteDiff(entityDir: string, kind: EntityDiff["kind"], id: string): EntityDiff {
  return { status: "delete", entityDir, kind, id };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildOperations", () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  // ─── Element description update ────────────────────────────────────────────
  it("update diff on element emits element.update-description", async () => {
    setupElement(root);
    const diffs: EntityDiff[] = [updateDiff(ELEMENT_DIR, "element", ELEMENT_ID)];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    const descOp = ops.find((o) => o.kind === "element.update-description");
    expect(descOp).toMatchObject({
      kind: "element.update-description",
      chapterId: CHAPTER_ID,
      elementId: ELEMENT_ID,
      newDescription: "Do something",
    });
  });

  // ─── Element details update ────────────────────────────────────────────────
  it("update diff on element emits element.update-details", async () => {
    setupElement(root);
    const diffs: EntityDiff[] = [updateDiff(ELEMENT_DIR, "element", ELEMENT_ID)];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    const detailsOp = ops.find((o) => o.kind === "element.update-details");
    expect(detailsOp).toMatchObject({
      kind: "element.update-details",
      chapterId: CHAPTER_ID,
      elementId: ELEMENT_ID,
      newDetails: "Detailed notes",
    });
  });

  // ─── Slice details update ──────────────────────────────────────────────────
  it("update diff on slice emits slice.update-details when details.md exists", async () => {
    setupSlice(root);
    const diffs: EntityDiff[] = [updateDiff(SLICE_DIR, "slice", SLICE_ID)];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    const detailsOp = ops.find((o) => o.kind === "slice.update-details");
    expect(detailsOp).toMatchObject({
      kind: "slice.update-details",
      chapterId: CHAPTER_ID,
      sliceId: SLICE_ID,
      newDetails: "Some slice details",
    });
  });

  // ─── Element create ────────────────────────────────────────────────────────
  it("create diff maps to element.create", async () => {
    setupElement(root);
    const diffs: EntityDiff[] = [createDiff(ELEMENT_DIR, "element")];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "element.create",
      chapterId: CHAPTER_ID,
      name: "My Element",
      type: "command",
      laneId: LANE_ID,
      sliceId: SLICE_ID,
    });
  });

  // ─── Element create picks up description and details ──────────────────────
  it("element.create includes description and details from disk", async () => {
    setupElement(root);
    const diffs: EntityDiff[] = [createDiff(ELEMENT_DIR, "element")];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    const creates = ops.filter((o) => o.kind === "element.create");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      kind: "element.create",
      description: "Do something",
      details: "Detailed notes",
    });
  });

  // ─── Element create picks up play-function.ts / play-type.ts ───────────────
  // Documents the fix for: "play-type.ts is silently dropped when an element is
  // created via sync-back". The board API does not accept play_type /
  // play_function on POST /elements or POST /event-reactions (see
  // AddElementRequest / AddEventReactionRequest in the OpenAPI spec) — the only
  // way to set them is POST /chapters/{cid}/elements/{eid}/config.
  // handleCreate emits an element.update-config op right after element.create
  // for the same entityDir. The executor runs ops in order, so the config lands
  // on the freshly created element.

  it("element.create is followed by element.update-config when play-function.ts and play-type.ts exist", async () => {
    // GIVEN a new element directory that contains both play config files
    setupElement(root);
    writeFile(root, `${ELEMENT_DIR}/play-function.ts`, "export const decide = () => [];");
    writeFile(root, `${ELEMENT_DIR}/play-type.ts`, "type Payload = { amountMl: number };");

    // WHEN the create diff is turned into API operations
    const ops = await buildOperations({ syncRootAbs: root, diffs: [createDiff(ELEMENT_DIR, "element")] });

    // THEN a config update for the same element follows the create op.
    // element.json carries an id, which the API stores as the element UUID
    // (localId), so update-config can reference it directly.
    const configOp = ops.find((o) => o.kind === "element.update-config");
    expect(configOp).toMatchObject({
      kind: "element.update-config",
      chapterId: CHAPTER_ID,
      elementId: ELEMENT_ID,
      entityDir: ELEMENT_DIR,
      playFunction: "export const decide = () => [];",
      // the `type Payload = ...;` wrapper is stripped, like in the update path
      playType: "{ amountMl: number }",
    });
  });

  it("orders element.update-config after its element.create in the same batch", async () => {
    // GIVEN a new element with play config files
    setupElement(root);
    writeFile(root, `${ELEMENT_DIR}/play-type.ts`, "type Payload = { amountMl: number };");

    // WHEN ops are built
    const ops = await buildOperations({ syncRootAbs: root, diffs: [createDiff(ELEMENT_DIR, "element")] });
    const kinds = ops.map((o) => o.kind);

    // THEN the create runs first — otherwise the config call would 404
    expect(kinds.indexOf("element.create")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("element.create")).toBeLessThan(kinds.indexOf("element.update-config"));
  });

  it("element.update-config after create carries only the fields that exist on disk", async () => {
    // GIVEN a new element that has a play type but no play function
    setupElement(root);
    writeFile(root, `${ELEMENT_DIR}/play-type.ts`, "type Payload = { amountMl: number };");

    // WHEN ops are built
    const ops = await buildOperations({ syncRootAbs: root, diffs: [createDiff(ELEMENT_DIR, "element")] });
    const configOp = ops.find((o) => o.kind === "element.update-config") as
      | { playFunction?: string; playType?: string }
      | undefined;

    // THEN only playType is set — playFunction is absent, not an empty string,
    // so the executor does not send a spurious field to the API
    expect(configOp?.playType).toBe("{ amountMl: number }");
    expect(configOp && "playFunction" in configOp && configOp.playFunction !== undefined).toBe(false);
  });

  it("element.create without play config files emits no element.update-config", async () => {
    // GIVEN a plain new element without play-function.ts / play-type.ts
    setupElement(root);

    // WHEN ops are built
    const ops = await buildOperations({ syncRootAbs: root, diffs: [createDiff(ELEMENT_DIR, "element")] });

    // THEN only the create is emitted — no spurious config call
    expect(ops.filter((o) => o.kind === "element.update-config")).toHaveLength(0);
  });

  it("element.update-config uses a pending-id sentinel when element.json has no id", async () => {
    // GIVEN a new element whose element.json does not carry an id — the API
    // will generate the UUID on create, so the config op must be rewritten by
    // the executor after the create returns (same mechanism as
    // PENDING_SCENARIO_ID for scenario follow-up ops)
    setupElement(root);
    writeJson(root, `${ELEMENT_DIR}/element.json`, {
      type: "command", name: "My Element", context: "App",
      laneId: LANE_ID, sliceId: SLICE_ID, index: 0,
    });
    writeFile(root, `${ELEMENT_DIR}/play-type.ts`, "type Payload = { amountMl: number };");

    // WHEN ops are built
    const ops = await buildOperations({ syncRootAbs: root, diffs: [createDiff(ELEMENT_DIR, "element")] });
    const configOp = ops.find((o) => o.kind === "element.update-config");

    // THEN the op carries the sentinel the executor substitutes post-create
    expect(configOp).toMatchObject({
      kind: "element.update-config",
      elementId: PENDING_ELEMENT_ID,
      entityDir: ELEMENT_DIR,
    });
  });

  // ─── Slice create ──────────────────────────────────────────────────────────
  it("create diff maps to slice.create", async () => {
    setupSlice(root);
    const diffs: EntityDiff[] = [createDiff(SLICE_DIR, "slice")];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "slice.create",
      chapterId: CHAPTER_ID,
      label: "My Slice",
    });
  });

  // ─── Chapter create ────────────────────────────────────────────────────────
  it("create diff maps to chapter.create", async () => {
    setupChapter(root);
    const diffs: EntityDiff[] = [createDiff(CHAPTER_DIR, "chapter")];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "chapter.create",
      name: "My Chapter",
      context: "App",
    });
  });

  // ─── Slice reorder ────────────────────────────────────────────────────────
  it("update diff on chapter with changed sliceOrder emits slice.reorder", async () => {
    const SLICE_ID_2 = "slice-uuid-2";
    const SLICE_ID_3 = "slice-uuid-3";
    const newOrder = [SLICE_ID_2, SLICE_ID, SLICE_ID_3];
    writeJson(root, `${CHAPTER_DIR}/chapter.json`, {
      id: CHAPTER_ID, name: "My Chapter", context: "App", mode: "event-modeling", index: 0,
      sliceOrder: newOrder,
    });
    const diffs: EntityDiff[] = [updateDiff(CHAPTER_DIR, "chapter", CHAPTER_ID, {
      oldFields: { name: "My Chapter", context: "App", sliceOrder: [SLICE_ID, SLICE_ID_2, SLICE_ID_3] },
    })];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    const reorderOp = ops.find((o) => o.kind === "slice.reorder");
    expect(reorderOp).toMatchObject({
      kind: "slice.reorder",
      chapterId: CHAPTER_ID,
      newSliceIds: newOrder,
    });
  });

  it("update diff on chapter with unchanged sliceOrder does NOT emit slice.reorder", async () => {
    const order = [SLICE_ID, "slice-uuid-2"];
    writeJson(root, `${CHAPTER_DIR}/chapter.json`, {
      id: CHAPTER_ID, name: "My Chapter", context: "App", mode: "event-modeling", index: 0,
      sliceOrder: order,
    });
    const diffs: EntityDiff[] = [updateDiff(CHAPTER_DIR, "chapter", CHAPTER_ID, {
      oldFields: { name: "My Chapter", context: "App", sliceOrder: order },
    })];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    expect(ops.find((o) => o.kind === "slice.reorder")).toBeUndefined();
  });

  it("update diff on chapter with no prior sliceOrder emits slice.reorder", async () => {
    const order = [SLICE_ID, "slice-uuid-2"];
    writeJson(root, `${CHAPTER_DIR}/chapter.json`, {
      id: CHAPTER_ID, name: "My Chapter", context: "App", mode: "event-modeling", index: 0,
      sliceOrder: order,
    });
    // oldFields has no sliceOrder → treated as changed
    const diffs: EntityDiff[] = [updateDiff(CHAPTER_DIR, "chapter", CHAPTER_ID, {
      oldFields: { name: "My Chapter", context: "App" },
    })];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    expect(ops.find((o) => o.kind === "slice.reorder")).toMatchObject({
      kind: "slice.reorder",
      chapterId: CHAPTER_ID,
      newSliceIds: order,
    });
  });

  // ─── localId forwarding ────────────────────────────────────────────────────
  it("chapter.create carries localId from chapter.json", async () => {
    setupChapter(root);
    const diffs: EntityDiff[] = [createDiff(CHAPTER_DIR, "chapter")];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    expect(ops[0]).toMatchObject({ kind: "chapter.create", localId: CHAPTER_ID });
  });

  it("slice.create carries localId from slice.json", async () => {
    setupSlice(root);
    const diffs: EntityDiff[] = [createDiff(SLICE_DIR, "slice")];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    const op = ops.find((o) => o.kind === "slice.create");
    expect(op).toMatchObject({ kind: "slice.create", localId: SLICE_ID });
  });

  it("lane.create carries localId from lane.json", async () => {
    setupLane(root);
    const diffs: EntityDiff[] = [createDiff(LANE_DIR, "lane")];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    const op = ops.find((o) => o.kind === "lane.create");
    expect(op).toMatchObject({ kind: "lane.create", localId: LANE_ID });
  });

  it("element.create carries localId from element.json", async () => {
    setupElement(root);
    const diffs: EntityDiff[] = [createDiff(ELEMENT_DIR, "element")];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    const op = ops.find((o) => o.kind === "element.create");
    expect(op).toMatchObject({ kind: "element.create", localId: ELEMENT_ID });
  });

  it("create ops have no localId when json has no id field", async () => {
    // Write a chapter.json without an id field
    writeJson(root, `${CHAPTER_DIR}/chapter.json`, { name: "No ID Chapter", context: "App", mode: "event-modeling" });
    const diffs: EntityDiff[] = [createDiff(CHAPTER_DIR, "chapter")];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    expect(ops[0]).toMatchObject({ kind: "chapter.create" });
    expect((ops[0] as any).localId).toBeUndefined();
  });

  // ─── Milestone create ──────────────────────────────────────────────────────
  it("create diff maps to milestone.create", async () => {
    setupMilestone(root);
    const diffs: EntityDiff[] = [createDiff(MILESTONE_DIR, "milestone")];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "milestone.create",
      name: "My Milestone",
      deadline: "2026-12-31",
    });
  });

  // ─── Milestone description update ─────────────────────────────────────────
  it("update diff on milestone emits milestone.update with description", async () => {
    setupMilestone(root);
    const diffs: EntityDiff[] = [updateDiff(MILESTONE_DIR, "milestone", MILESTONE_ID)];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    const updateOp = ops.find((o) => o.kind === "milestone.update");
    expect(updateOp).toMatchObject({
      kind: "milestone.update",
      milestoneId: MILESTONE_ID,
      description: "Milestone description",
    });
  });

  // ─── Delete ────────────────────────────────────────────────────────────────
  it("delete diff on element emits element.delete", async () => {
    setupLane(root); // parent dirs needed to resolve chapterId
    const diffs: EntityDiff[] = [deleteDiff(ELEMENT_DIR, "element", ELEMENT_ID)];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "element.delete",
      chapterId: CHAPTER_ID,
      elementId: ELEMENT_ID,
    });
  });

  it("delete diff on slice emits slice.delete", async () => {
    setupChapter(root);
    const diffs: EntityDiff[] = [deleteDiff(SLICE_DIR, "slice", SLICE_ID)];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: "slice.delete", chapterId: CHAPTER_ID, sliceId: SLICE_ID });
  });

  it("delete diff on milestone emits milestone.delete", async () => {
    const diffs: EntityDiff[] = [deleteDiff(MILESTONE_DIR, "milestone", MILESTONE_ID)];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: "milestone.delete", milestoneId: MILESTONE_ID });
  });

  // ─── Element rename (via update diff) ────────────────────────────────────
  it("update diff on element with changed name emits element.rename", async () => {
    setupElement(root);
    writeJson(root, `${ELEMENT_DIR}/element.json`, {
      id: ELEMENT_ID, type: "command", name: "New Name", context: "App",
      laneId: LANE_ID, sliceId: SLICE_ID, index: 0,
    });
    // oldFields: same lane/slice — only name changed
    const diffs: EntityDiff[] = [updateDiff(ELEMENT_DIR, "element", ELEMENT_ID, {
      oldFields: { name: "My Element", laneId: LANE_ID, sliceId: SLICE_ID, index: 0 },
    })];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    const renames = ops.filter((o) => o.kind === "element.rename");
    expect(renames).toHaveLength(1);
    expect(renames[0]).toMatchObject({
      kind: "element.rename",
      chapterId: CHAPTER_ID,
      elementId: ELEMENT_ID,
      newName: "New Name",
    });
    // No spurious move
    expect(ops.filter((o) => o.kind === "element.move")).toHaveLength(0);
  });

  // ─── Element move (via update diff) ───────────────────────────────────────
  it("update diff on element with changed laneId emits element.move", async () => {
    setupElement(root);
    const NEW_LANE_ID = "lane-uuid-2";
    writeJson(root, `${ELEMENT_DIR}/element.json`, {
      id: ELEMENT_ID, type: "command", name: "My Element", context: "App",
      laneId: NEW_LANE_ID, sliceId: SLICE_ID, index: 0,
    });
    // oldFields: different laneId — this is a move
    const diffs: EntityDiff[] = [updateDiff(ELEMENT_DIR, "element", ELEMENT_ID, {
      oldFields: { name: "My Element", laneId: LANE_ID, sliceId: SLICE_ID, index: 0 },
    })];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    const moves = ops.filter((o) => o.kind === "element.move");
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({
      kind: "element.move",
      elementId: ELEMENT_ID,
      newLaneId: NEW_LANE_ID,
      newSliceId: SLICE_ID,
    });
  });

  // ─── Operation ordering ────────────────────────────────────────────────────
  it("orders creates before updates in same batch", async () => {
    setupElement(root);
    const diffs: EntityDiff[] = [
      updateDiff(ELEMENT_DIR, "element", ELEMENT_ID),
      createDiff(ELEMENT_DIR, "element"),
    ];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    const kinds = ops.map((o) => o.kind);
    const createIdx = kinds.indexOf("element.create");
    const updateIdx = kinds.indexOf("element.update-description");
    if (createIdx !== -1 && updateIdx !== -1) {
      expect(createIdx).toBeLessThan(updateIdx);
    }
  });

  it("orders chapter creates before slice creates", async () => {
    setupSlice(root);
    const diffs: EntityDiff[] = [
      createDiff(SLICE_DIR, "slice"),
      createDiff(CHAPTER_DIR, "chapter"),
    ];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    const kinds = ops.map((o) => o.kind);
    expect(kinds.indexOf("chapter.create")).toBeLessThan(kinds.indexOf("slice.create"));
  });

  // ─── Cell-occupancy ordering (002-sync-back-cell-ordering.md) ──────────────
  // The board rejects a create into a cell that is still occupied. Operations
  // that vacate a cell (element.move, element.delete) must therefore run before
  // element.create — while staying after slice.create/lane.create, because a
  // move may target a slice/lane created in the same run.

  const ELEMENT_DIR_2 = `${CHAPTER_DIR}/elements/element-uuid-2`;

  function setupElementMove(root: string): void {
    // element.json on disk already carries the NEW sliceId (the local edit);
    // oldFields still record the previous position → emits element.move.
    setupElement(root);
  }

  const MOVE_DIFF = () =>
    updateDiff(ELEMENT_DIR, "element", ELEMENT_ID, {
      oldFields: { name: "My Element", laneId: LANE_ID, sliceId: "slice-old", index: 0 },
    });

  it("orders element.move before element.create into the vacated cell", async () => {
    setupElementMove(root);
    writeJson(root, `${ELEMENT_DIR_2}/element.json`, {
      id: "element-uuid-2", type: "information", name: "New Info", context: "App",
      laneId: LANE_ID, sliceId: "slice-old", index: 0,
    });
    const ops = await buildOperations({
      syncRootAbs: root,
      diffs: [createDiff(ELEMENT_DIR_2, "element"), MOVE_DIFF()],
    });
    const kinds = ops.map((o) => o.kind);
    expect(kinds.indexOf("element.move")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("element.create")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("element.move")).toBeLessThan(kinds.indexOf("element.create"));
  });

  it("orders element.delete before element.create", async () => {
    setupLane(root);
    writeJson(root, `${ELEMENT_DIR_2}/element.json`, {
      id: "element-uuid-2", type: "information", name: "New Info", context: "App",
      laneId: LANE_ID, sliceId: SLICE_ID, index: 0,
    });
    const ops = await buildOperations({
      syncRootAbs: root,
      diffs: [
        createDiff(ELEMENT_DIR_2, "element"),
        deleteDiff(ELEMENT_DIR, "element", ELEMENT_ID),
      ],
    });
    const kinds = ops.map((o) => o.kind);
    expect(kinds.indexOf("element.delete")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("element.create")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("element.delete")).toBeLessThan(kinds.indexOf("element.create"));
  });

  it("orders element.delete before element.move (a move's target cell may be freed by a delete)", async () => {
    setupElementMove(root);
    const ops = await buildOperations({
      syncRootAbs: root,
      diffs: [MOVE_DIFF(), deleteDiff(ELEMENT_DIR_2, "element", "element-uuid-2")],
    });
    const kinds = ops.map((o) => o.kind);
    expect(kinds.indexOf("element.delete")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("element.delete")).toBeLessThan(kinds.indexOf("element.move"));
  });

  it("keeps element.move after slice.create (a move may target a slice created in the same run)", async () => {
    setupElementMove(root);
    const ops = await buildOperations({
      syncRootAbs: root,
      diffs: [createDiff(SLICE_DIR, "slice"), MOVE_DIFF()],
    });
    const kinds = ops.map((o) => o.kind);
    expect(kinds.indexOf("slice.create")).toBeLessThan(kinds.indexOf("element.move"));
  });

  // ─── Element play-function update ─────────────────────────────────────────
  it("update diff on element with play-function.ts emits element.update-config", async () => {
    setupElement(root);
    writeFile(root, `${ELEMENT_DIR}/play-function.ts`, "async function play() { return {}; }");
    const diffs: EntityDiff[] = [updateDiff(ELEMENT_DIR, "element", ELEMENT_ID)];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    const configOp = ops.find((o) => o.kind === "element.update-config");
    expect(configOp).toMatchObject({
      kind: "element.update-config",
      chapterId: CHAPTER_ID,
      elementId: ELEMENT_ID,
      playFunction: "async function play() { return {}; }",
    });
  });

  // ─── Slice status update ───────────────────────────────────────────────────
  it("update diff on slice emits slice.update-status", async () => {
    setupSlice(root);
    writeJson(root, `${SLICE_DIR}/slice.json`, {
      id: SLICE_ID, label: "My Slice", index: 0, status: "planned",
    });
    const diffs: EntityDiff[] = [updateDiff(SLICE_DIR, "slice", SLICE_ID)];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    const statusOp = ops.find((o) => o.kind === "slice.update-status");
    expect(statusOp).toMatchObject({
      kind: "slice.update-status",
      sliceId: SLICE_ID,
      newStatus: "planned",
    });
  });

  // ─── Key fix: gitignored mirror — update does NOT become spurious create ───
  it("update diff for existing entity (id in json) never produces a create op", async () => {
    // This is the core regression test for the original bug:
    // In the old git-based approach, a staged file in a gitignored dir was always
    // status "A", causing existing entities to emit create operations.
    // With manifest-based diffs the status is explicit — "update" stays "update".
    setupSlice(root);
    writeJson(root, `${SLICE_DIR}/slice.json`, {
      id: SLICE_ID, label: "My Slice", index: 0, status: "planned",
    });
    const diffs: EntityDiff[] = [updateDiff(SLICE_DIR, "slice", SLICE_ID)];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    expect(ops.filter((o) => o.kind === "slice.create")).toHaveLength(0);
    expect(ops.filter((o) => o.kind === "slice.update-status")).toHaveLength(1);
  });

  // ─── Markdown content is read as-is ──────────────────────────────────────
  it("reads markdown content as-is from disk", async () => {
    setupElement(root);
    const diffs: EntityDiff[] = [updateDiff(ELEMENT_DIR, "element", ELEMENT_ID)];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    const descOp = ops.find((o) => o.kind === "element.update-description") as { newDescription: string } | undefined;
    expect(descOp?.newDescription).toBe("Do something");
  });

  // ─── No ops for empty diffs ────────────────────────────────────────────────
  it("returns empty ops for empty diffs", async () => {
    const ops = await buildOperations({ syncRootAbs: root, diffs: [] });
    expect(ops).toHaveLength(0);
  });

  // ─── Scenario update: interactions unchanged → no interaction ops ─────────
  it("update diff on scenario emits no interaction ops when interactions unchanged", async () => {
    setupChapter(root);
    const SCENARIO_ID = "scenario-uuid-1";
    const SCENARIO_DIR = `${CHAPTER_DIR}/scenarios/My-Scenario`;
    const interactions = [{ uiElementId: "ui-1", storage: { x: 1 } }];
    writeJson(root, `${SCENARIO_DIR}/scenario.json`, {
      id: SCENARIO_ID,
      chapterId: CHAPTER_ID,
      name: "My Scenario",
      interactions,
    });
    const diffs: EntityDiff[] = [
      updateDiff(SCENARIO_DIR, "scenario", SCENARIO_ID, {
        oldInteractions: interactions, // same as on disk
      }),
    ];
    const ops = await buildOperations({ syncRootAbs: root, diffs });

    expect(ops.find((o) => o.kind === "scenario.clear-interactions")).toBeUndefined();
    expect(ops.find((o) => o.kind === "scenario.record-interaction")).toBeUndefined();
  });

  // ─── Scenario update: step changed → upsert only that step ───────────────
  it("update diff on scenario upserts only the changed step (no clear)", async () => {
    setupChapter(root);
    const SCENARIO_ID = "scenario-uuid-1";
    const SCENARIO_DIR = `${CHAPTER_DIR}/scenarios/My-Scenario`;
    writeJson(root, `${SCENARIO_DIR}/scenario.json`, {
      id: SCENARIO_ID,
      chapterId: CHAPTER_ID,
      name: "My Scenario",
      interactions: [
        { uiElementId: "ui-1", storage: { x: 1 } },        // changed
        { uiElementId: "ui-2", storage: { y: 2 } },        // unchanged
      ],
    });
    const diffs: EntityDiff[] = [
      updateDiff(SCENARIO_DIR, "scenario", SCENARIO_ID, {
        oldInteractions: [
          { uiElementId: "ui-1", storage: { x: 99 } },     // was different
          { uiElementId: "ui-2", storage: { y: 2 } },      // unchanged
        ],
      }),
    ];
    const ops = await buildOperations({ syncRootAbs: root, diffs });

    expect(ops.find((o) => o.kind === "scenario.clear-interactions")).toBeUndefined();
    const recordOps = ops.filter((o) => o.kind === "scenario.record-interaction");
    expect(recordOps).toHaveLength(1);
    expect(recordOps[0]).toMatchObject({ uiElementId: "ui-1", storage: { x: 1 } });
  });

  // ─── Scenario update: step added → upsert only the new step ──────────────
  it("update diff on scenario upserts only the new step when a step is added", async () => {
    setupChapter(root);
    const SCENARIO_ID = "scenario-uuid-1";
    const SCENARIO_DIR = `${CHAPTER_DIR}/scenarios/My-Scenario`;
    writeJson(root, `${SCENARIO_DIR}/scenario.json`, {
      id: SCENARIO_ID,
      chapterId: CHAPTER_ID,
      name: "My Scenario",
      interactions: [
        { uiElementId: "ui-1", storage: { x: 1 } },   // unchanged
        { uiElementId: "ui-2", storage: { y: 2 } },   // new
      ],
    });
    const diffs: EntityDiff[] = [
      updateDiff(SCENARIO_DIR, "scenario", SCENARIO_ID, {
        oldInteractions: [{ uiElementId: "ui-1", storage: { x: 1 } }],
      }),
    ];
    const ops = await buildOperations({ syncRootAbs: root, diffs });

    expect(ops.find((o) => o.kind === "scenario.clear-interactions")).toBeUndefined();
    const recordOps = ops.filter((o) => o.kind === "scenario.record-interaction");
    expect(recordOps).toHaveLength(1);
    expect(recordOps[0]).toMatchObject({ uiElementId: "ui-2", storage: { y: 2 } });
  });

  // ─── Scenario update: step removed → clear + re-record all ───────────────
  it("update diff on scenario does clear + re-record when a step is removed", async () => {
    setupChapter(root);
    const SCENARIO_ID = "scenario-uuid-1";
    const SCENARIO_DIR = `${CHAPTER_DIR}/scenarios/My-Scenario`;
    writeJson(root, `${SCENARIO_DIR}/scenario.json`, {
      id: SCENARIO_ID,
      chapterId: CHAPTER_ID,
      name: "My Scenario",
      interactions: [{ uiElementId: "ui-1", storage: { x: 1 } }], // one step remains
    });
    const diffs: EntityDiff[] = [
      updateDiff(SCENARIO_DIR, "scenario", SCENARIO_ID, {
        oldInteractions: [
          { uiElementId: "ui-1", storage: { x: 1 } },
          { uiElementId: "ui-2", storage: { y: 2 } }, // was here, now removed
        ],
      }),
    ];
    const ops = await buildOperations({ syncRootAbs: root, diffs });

    expect(ops.find((o) => o.kind === "scenario.clear-interactions")).toBeDefined();
    const recordOps = ops.filter((o) => o.kind === "scenario.record-interaction");
    expect(recordOps).toHaveLength(1);
    expect(recordOps[0]).toMatchObject({ uiElementId: "ui-1", storage: { x: 1 } });
  });

  // ─── Scenario update: all steps removed → clear only ─────────────────────
  it("update diff on scenario emits only clear when all interactions removed", async () => {
    setupChapter(root);
    const SCENARIO_ID = "scenario-uuid-1";
    const SCENARIO_DIR = `${CHAPTER_DIR}/scenarios/My-Scenario`;
    writeJson(root, `${SCENARIO_DIR}/scenario.json`, {
      id: SCENARIO_ID,
      chapterId: CHAPTER_ID,
      name: "My Scenario",
      // no interactions
    });
    const diffs: EntityDiff[] = [
      updateDiff(SCENARIO_DIR, "scenario", SCENARIO_ID, {
        oldInteractions: [{ uiElementId: "ui-1", storage: { x: 1 } }],
      }),
    ];
    const ops = await buildOperations({ syncRootAbs: root, diffs });

    expect(ops.find((o) => o.kind === "scenario.clear-interactions")).toBeDefined();
    expect(ops.filter((o) => o.kind === "scenario.record-interaction")).toHaveLength(0);
  });

  // ─── Scenario create (minimal — name only) ────────────────────────────────
  it("create diff on scenario emits only scenario.create when no interactions or expectations", async () => {
    setupChapter(root);
    const SCENARIO_DIR = `${CHAPTER_DIR}/scenarios/My-Scenario`;
    writeJson(root, `${SCENARIO_DIR}/scenario.json`, {
      name: "My Scenario",
      chapterId: CHAPTER_ID,
      clock: null,
    });
    const diffs: EntityDiff[] = [createDiff(SCENARIO_DIR, "scenario")];
    const ops = await buildOperations({ syncRootAbs: root, diffs });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "scenario.create",
      chapterId: CHAPTER_ID,
      name: "My Scenario",
      entityDir: SCENARIO_DIR,
    });
  });

  // ─── Scenario create with interactions ───────────────────────────────────
  it("create diff on scenario emits record-interaction ops (no clear — upsert semantics)", async () => {
    setupChapter(root);
    const SCENARIO_DIR = `${CHAPTER_DIR}/scenarios/My-Scenario`;
    writeJson(root, `${SCENARIO_DIR}/scenario.json`, {
      name: "My Scenario",
      chapterId: CHAPTER_ID,
      clock: null,
      interactions: [
        { uiElementId: "elem-ui-1", storage: { clicked: true } },
        { uiElementId: "elem-ui-2", storage: { value: "hello" } },
      ],
    });
    const diffs: EntityDiff[] = [createDiff(SCENARIO_DIR, "scenario")];
    const ops = await buildOperations({ syncRootAbs: root, diffs });

    // scenario.create comes first (priority 3)
    expect(ops[0]).toMatchObject({ kind: "scenario.create", chapterId: CHAPTER_ID, name: "My Scenario" });

    // No clear-interactions — record-interaction is an upsert, no clear needed for a new scenario
    expect(ops.find((o) => o.kind === "scenario.clear-interactions")).toBeUndefined();

    // two record-interaction ops with sentinel ID
    const recordOps = ops.filter((o) => o.kind === "scenario.record-interaction");
    expect(recordOps).toHaveLength(2);
    expect(recordOps[0]).toMatchObject({
      kind: "scenario.record-interaction",
      chapterId: CHAPTER_ID,
      scenarioId: PENDING_SCENARIO_ID,
      uiElementId: "elem-ui-1",
      storage: { clicked: true },
    });
    expect(recordOps[1]).toMatchObject({
      kind: "scenario.record-interaction",
      scenarioId: PENDING_SCENARIO_ID,
      uiElementId: "elem-ui-2",
      storage: { value: "hello" },
    });
  });

  // ─── Scenario create with expectations ───────────────────────────────────
  it("create diff on scenario emits scenario.set-expectation ops", async () => {
    setupChapter(root);
    const SCENARIO_DIR = `${CHAPTER_DIR}/scenarios/My-Scenario`;
    writeJson(root, `${SCENARIO_DIR}/scenario.json`, {
      name: "My Scenario",
      chapterId: CHAPTER_ID,
      expectations: [
        { id: "exp-1", sliceId: SLICE_ID, kind: "state", expected: { count: 1 } },
        { id: "exp-2", sliceId: SLICE_ID, kind: "event", elementId: "elem-1", expected: { type: "UserCreated" } },
      ],
    });
    const diffs: EntityDiff[] = [createDiff(SCENARIO_DIR, "scenario")];
    const ops = await buildOperations({ syncRootAbs: root, diffs });

    const setOps = ops.filter((o) => o.kind === "scenario.set-expectation");
    expect(setOps).toHaveLength(2);
    expect(setOps[0]).toMatchObject({
      kind: "scenario.set-expectation",
      chapterId: CHAPTER_ID,
      scenarioId: PENDING_SCENARIO_ID,
      expectation: { id: "exp-1", sliceId: SLICE_ID, kind: "state", expected: { count: 1 } },
    });
    expect(setOps[1]).toMatchObject({
      kind: "scenario.set-expectation",
      scenarioId: PENDING_SCENARIO_ID,
      expectation: { id: "exp-2", elementId: "elem-1" },
    });
  });

  // ─── Scenario create with both interactions and expectations ─────────────
  it("create diff with both interactions and expectations emits all follow-up ops with sentinel", async () => {
    setupChapter(root);
    const SCENARIO_DIR = `${CHAPTER_DIR}/scenarios/Full-Scenario`;
    writeJson(root, `${SCENARIO_DIR}/scenario.json`, {
      name: "Full Scenario",
      chapterId: CHAPTER_ID,
      interactions: [{ uiElementId: "ui-1", storage: { x: 1 } }],
      expectations: [{ id: "exp-1", sliceId: SLICE_ID, kind: "state", expected: {} }],
    });
    const diffs: EntityDiff[] = [createDiff(SCENARIO_DIR, "scenario")];
    const ops = await buildOperations({ syncRootAbs: root, diffs });

    // scenario.create is first
    expect(ops[0]!.kind).toBe("scenario.create");

    // All follow-up ops use the sentinel ID — no clear-interactions (upsert semantics)
    const followUps = ops.slice(1);
    expect(followUps.every((o) => "scenarioId" in o && (o as { scenarioId: string }).scenarioId === PENDING_SCENARIO_ID)).toBe(true);
    expect(followUps.map((o) => o.kind)).toEqual([
      "scenario.record-interaction",
      "scenario.set-expectation",
    ]);
  });

  // ─── Scenario create ordering: scenario.create before record-interaction ─
  it("scenario.create is ordered before its follow-up record-interaction ops", async () => {
    setupChapter(root);
    const SCENARIO_DIR = `${CHAPTER_DIR}/scenarios/My-Scenario`;
    writeJson(root, `${SCENARIO_DIR}/scenario.json`, {
      name: "My Scenario",
      chapterId: CHAPTER_ID,
      interactions: [{ uiElementId: "ui-1", storage: {} }],
    });
    const diffs: EntityDiff[] = [createDiff(SCENARIO_DIR, "scenario")];
    const ops = await buildOperations({ syncRootAbs: root, diffs });

    const createIdx = ops.findIndex((o) => o.kind === "scenario.create");
    const recordIdx = ops.findIndex((o) => o.kind === "scenario.record-interaction");
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(recordIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeLessThan(recordIdx);
  });

  // ─── Slice ordering (bug-report-slice-order.md) ────────────────────────────
  //
  // The API interprets `index` on POST /slices as an *insertion position*
  // (clamped to the end of the list). Therefore the order in which slice.create
  // ops are emitted determines the resulting board order. Ops are only sorted
  // by PRIORITY (stable sort), so they keep the diff order — which comes from
  // the directory walk (lexically sorted dir names on common filesystems),
  // not from the `index` field.
  describe("slice ordering", () => {
    // Dir names chosen so lexical order (the walk order) is X, B, A while the
    // modeled slice order is A (index 0), B (index 1), X (index 2).
    const SLICE_X = "00000000-0000-4000-8000-0000000000aa";
    const SLICE_B = "a0000000-0000-4000-8000-0000000000bb";
    const SLICE_A = "f0000000-0000-4000-8000-0000000000cc";
    const DIR_X = `${CHAPTER_DIR}/slices/${SLICE_X}`;
    const DIR_B = `${CHAPTER_DIR}/slices/${SLICE_B}`;
    const DIR_A = `${CHAPTER_DIR}/slices/${SLICE_A}`;

    function setupOrderedSlices(): void {
      writeJson(root, `${CHAPTER_DIR}/chapter.json`, {
        id: CHAPTER_ID, name: "Ordered", context: "App", mode: "event-modeling",
        sliceOrder: [SLICE_A, SLICE_B, SLICE_X],
      });
      writeJson(root, `${DIR_X}/slice.json`, { id: SLICE_X, label: "X", index: 2 });
      writeJson(root, `${DIR_B}/slice.json`, { id: SLICE_B, label: "B", index: 1 });
      writeJson(root, `${DIR_A}/slice.json`, { id: SLICE_A, label: "A", index: 0 });
    }

    // Diffs in lexical dir order, as computeManifestDiff emits them.
    const diffsInWalkOrder = (): EntityDiff[] => [
      createDiff(DIR_X, "slice"),
      createDiff(DIR_B, "slice"),
      createDiff(DIR_A, "slice"),
    ];

    // Regression test for the reported bug: create ops must be emitted in
    // index order regardless of the diff (dir walk) order.
    it("emits slice.create ops in index order, not dir order", async () => {
      setupOrderedSlices();
      const ops = await buildOperations({ syncRootAbs: root, diffs: diffsInWalkOrder() });
      const labels = ops
        .filter((o) => o.kind === "slice.create")
        .map((o) => o.kind === "slice.create" ? o.label : "");
      expect(labels).toEqual(["A", "B", "X"]);
    });

    // Shows *why* the op order matters: simulating the API's insert-at-index
    // semantics on the emitted ops must produce the modeled board order.
    it("simulated API insertion yields the modeled slice order", async () => {
      setupOrderedSlices();
      const ops = await buildOperations({ syncRootAbs: root, diffs: diffsInWalkOrder() });
      const creates = ops.filter((o) => o.kind === "slice.create") as Array<
        Extract<typeof ops[number], { kind: "slice.create" }>
      >;
      const board: string[] = [];
      for (const op of creates) {
        const pos = Math.min(op.index ?? board.length, board.length);
        board.splice(pos, 0, op.label);
      }
      expect(board).toEqual(["A", "B", "X"]);
    });

    // When sliceOrder in chapter.json changes, we now emit a slice.reorder op.
    // The /slices/reorder endpoint is confirmed working (POST {new_slice_ids: [...]}).
    it("emits slice.reorder when chapter sliceOrder changes", async () => {
      setupOrderedSlices();
      // Simulate the user reordering: chapter.json now has A at index 5, sliceOrder reflects new order
      writeJson(root, `${DIR_A}/slice.json`, { id: SLICE_A, label: "A", index: 5 });
      const newOrder = [SLICE_B, SLICE_X, SLICE_A];
      writeJson(root, `${CHAPTER_DIR}/chapter.json`, { id: CHAPTER_ID, name: "Ordered", context: "App", mode: "event-modeling", index: 0, sliceOrder: newOrder });
      const diffs: EntityDiff[] = [
        updateDiff(DIR_A, "slice", SLICE_A, { oldFields: { id: SLICE_A, label: "A", index: 0 } }),
        updateDiff(CHAPTER_DIR, "chapter", CHAPTER_ID, { oldFields: { id: CHAPTER_ID, name: "Ordered", context: "App", sliceOrder: [SLICE_A, SLICE_B, SLICE_X] } }),
      ];
      const ops = await buildOperations({ syncRootAbs: root, diffs });
      const reorderOp = ops.find((o) => o.kind === "slice.reorder");
      expect(reorderOp).toMatchObject({
        kind: "slice.reorder",
        chapterId: CHAPTER_ID,
        newSliceIds: newOrder,
      });
    });
  });
});
