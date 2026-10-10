import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildOperations } from "./operationBuilder.js";
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

const CHAPTER_DIR  = "chapters/App/My-Chapter";
const SLICE_DIR    = `${CHAPTER_DIR}/slices/0001_My-Slice`;
const LANE_DIR     = `${SLICE_DIR}/lanes/information-flow/My-Lane`;
const ELEMENT_DIR  = `${LANE_DIR}/elements/0001_My-Element`;
const MILESTONE_DIR = "milestones/My-Milestone";

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

function renameDiff(entityDir: string, kind: EntityDiff["kind"], id: string, oldEntityDir: string): EntityDiff {
  return { status: "rename", entityDir, kind, id, oldEntityDir };
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

  // ─── Rename/move ──────────────────────────────────────────────────────────
  it("rename diff on element in same lane emits element.rename", async () => {
    const NEW_ELEMENT_DIR = `${LANE_DIR}/elements/0001_New-Name`;
    setupLane(root);
    writeJson(root, `${NEW_ELEMENT_DIR}/element.json`, {
      id: ELEMENT_ID, type: "command", name: "New Name", context: "App",
      laneId: LANE_ID, sliceId: SLICE_ID, index: 0,
    });
    const diffs: EntityDiff[] = [renameDiff(NEW_ELEMENT_DIR, "element", ELEMENT_ID, ELEMENT_DIR)];
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

  it("rename diff on element in different lane emits element.move", async () => {
    const NEW_LANE_DIR    = `${SLICE_DIR}/lanes/system/System-Lane`;
    const NEW_ELEMENT_DIR = `${NEW_LANE_DIR}/elements/0001_My-Element`;
    const NEW_LANE_ID     = "lane-uuid-2";
    setupLane(root);
    writeJson(root, `${NEW_LANE_DIR}/lane.json`, { id: NEW_LANE_ID, label: "System Lane", type: "system", index: 1 });
    writeJson(root, `${NEW_ELEMENT_DIR}/element.json`, {
      id: ELEMENT_ID, type: "command", name: "My Element", context: "App",
      laneId: NEW_LANE_ID, sliceId: SLICE_ID, index: 0,
    });
    const diffs: EntityDiff[] = [renameDiff(NEW_ELEMENT_DIR, "element", ELEMENT_ID, ELEMENT_DIR)];
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
});
