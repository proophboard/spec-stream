import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildOperations } from "./operationBuilder.js";
import type { FileChange } from "./gitDiff.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRoot(): string {
  const dir = join(tmpdir(), `spec-stream-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(root: string, relPath: string, data: unknown): void {
  const abs = join(root, relPath);
  mkdirSync(require_dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(data, null, 2), "utf8");
}

function writeFile(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(require_dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function require_dirname(filePath: string): string {
  return filePath.slice(0, filePath.lastIndexOf("/") === -1 ? filePath.lastIndexOf("\\") : filePath.lastIndexOf("/"));
}

// Generated marker that render.ts used to put in markdown files (no longer added).
// Files written by agents or manually will have no such prefix.

// ─── Test fixtures ────────────────────────────────────────────────────────────

const CHAPTER_ID = "chapter-uuid-1";
const SLICE_ID = "slice-uuid-1";
const LANE_ID = "lane-uuid-1";
const ELEMENT_ID = "element-uuid-1";
const MILESTONE_ID = "milestone-uuid-1";

const CHAPTER_DIR = "chapters/App/My-Chapter";
const SLICE_DIR = `${CHAPTER_DIR}/slices/0001_My-Slice`;
const LANE_DIR = `${SLICE_DIR}/lanes/information-flow/My-Lane`;
const ELEMENT_DIR = `${LANE_DIR}/elements/0001_My-Element`;
const MILESTONE_DIR = "milestones/My-Milestone";

function setupChapter(root: string): void {
  writeJson(root, `${CHAPTER_DIR}/chapter.json`, {
    id: CHAPTER_ID,
    name: "My Chapter",
    context: "App",
    mode: "event-modeling",
    index: 0,
  });
}

function setupSlice(root: string): void {
  setupChapter(root);
  writeJson(root, `${SLICE_DIR}/slice.json`, {
    id: SLICE_ID,
    label: "My Slice",
    index: 0,
    status: "draft",
  });
  writeFile(root, `${SLICE_DIR}/details.md`, `Some slice details`);
}

function setupLane(root: string): void {
  setupSlice(root);
  writeJson(root, `${LANE_DIR}/lane.json`, {
    id: LANE_ID,
    label: "My Lane",
    type: "information-flow",
    index: 0,
    height: 150,
  });
}

function setupElement(root: string): void {
  setupLane(root);
  writeJson(root, `${ELEMENT_DIR}/element.json`, {
    id: ELEMENT_ID,
    type: "command",
    name: "My Element",
    context: "App",
    laneId: LANE_ID,
    sliceId: SLICE_ID,
    index: 0,
  });
  writeFile(root, `${ELEMENT_DIR}/description.md`, `Do something`);
  writeFile(root, `${ELEMENT_DIR}/details.md`, `Detailed notes`);
}

function setupMilestone(root: string): void {
  writeJson(root, `${MILESTONE_DIR}/milestone.json`, {
    id: MILESTONE_ID,
    name: "My Milestone",
    deadline: "2026-12-31",
    color: "#3b82f6",
  });
  writeFile(root, `${MILESTONE_DIR}/description.md`, `Milestone description`);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildOperations", () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ─── Element description update ────────────────────────────────────────────
  it("maps modified description.md to element.update-description", async () => {
    setupElement(root);
    const changes: FileChange[] = [
      { status: "M", path: `${ELEMENT_DIR}/description.md` },
    ];
    const ops = await buildOperations({ syncRootAbs: root, changes });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "element.update-description",
      chapterId: CHAPTER_ID,
      elementId: ELEMENT_ID,
      newDescription: "Do something",
    });
  });

  // ─── Element details update ────────────────────────────────────────────────
  it("maps modified details.md to element.update-details", async () => {
    setupElement(root);
    const changes: FileChange[] = [
      { status: "M", path: `${ELEMENT_DIR}/details.md` },
    ];
    const ops = await buildOperations({ syncRootAbs: root, changes });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "element.update-details",
      chapterId: CHAPTER_ID,
      elementId: ELEMENT_ID,
      newDetails: "Detailed notes",
    });
  });

  // ─── Slice details update ──────────────────────────────────────────────────
  it("maps modified slice details.md to slice.update-details", async () => {
    setupSlice(root);
    const changes: FileChange[] = [
      { status: "M", path: `${SLICE_DIR}/details.md` },
    ];
    const ops = await buildOperations({ syncRootAbs: root, changes });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "slice.update-details",
      chapterId: CHAPTER_ID,
      sliceId: SLICE_ID,
      newDetails: "Some slice details",
    });
  });

  // ─── Element create ────────────────────────────────────────────────────────
  it("maps added element.json to element.create", async () => {
    setupElement(root);
    const changes: FileChange[] = [
      { status: "A", path: `${ELEMENT_DIR}/element.json` },
    ];
    const ops = await buildOperations({ syncRootAbs: root, changes });
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
    const changes: FileChange[] = [
      { status: "A", path: `${ELEMENT_DIR}/element.json` },
      { status: "A", path: `${ELEMENT_DIR}/description.md` },
      { status: "A", path: `${ELEMENT_DIR}/details.md` },
    ];
    const ops = await buildOperations({ syncRootAbs: root, changes });
    // Should only be one create (deduplicated), not three operations
    const creates = ops.filter((o) => o.kind === "element.create");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      kind: "element.create",
      description: "Do something",
      details: "Detailed notes",
    });
  });

  // ─── Slice create ──────────────────────────────────────────────────────────
  it("maps added slice.json to slice.create", async () => {
    setupSlice(root);
    const changes: FileChange[] = [
      { status: "A", path: `${SLICE_DIR}/slice.json` },
    ];
    const ops = await buildOperations({ syncRootAbs: root, changes });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "slice.create",
      chapterId: CHAPTER_ID,
      label: "My Slice",
    });
  });

  // ─── Chapter create ────────────────────────────────────────────────────────
  it("maps added chapter.json to chapter.create", async () => {
    setupChapter(root);
    const changes: FileChange[] = [
      { status: "A", path: `${CHAPTER_DIR}/chapter.json` },
    ];
    const ops = await buildOperations({ syncRootAbs: root, changes });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "chapter.create",
      name: "My Chapter",
      context: "App",
    });
  });

  // ─── Milestone create ──────────────────────────────────────────────────────
  it("maps added milestone.json to milestone.create", async () => {
    setupMilestone(root);
    const changes: FileChange[] = [
      { status: "A", path: `${MILESTONE_DIR}/milestone.json` },
    ];
    const ops = await buildOperations({ syncRootAbs: root, changes });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "milestone.create",
      name: "My Milestone",
      deadline: "2026-12-31",
    });
  });

  // ─── Milestone description update ─────────────────────────────────────────
  it("maps modified milestone description.md to milestone.update", async () => {
    setupMilestone(root);
    const changes: FileChange[] = [
      { status: "M", path: `${MILESTONE_DIR}/description.md` },
    ];
    const ops = await buildOperations({ syncRootAbs: root, changes });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "milestone.update",
      milestoneId: MILESTONE_ID,
      description: "Milestone description",
    });
  });

  // ─── Operation ordering ────────────────────────────────────────────────────
  it("orders creates before updates", async () => {
    setupElement(root);
    const changes: FileChange[] = [
      { status: "M", path: `${ELEMENT_DIR}/description.md` },
      { status: "A", path: `${ELEMENT_DIR}/element.json` },
    ];
    const ops = await buildOperations({ syncRootAbs: root, changes });
    const kinds = ops.map((o) => o.kind);
    const createIdx = kinds.indexOf("element.create");
    const updateIdx = kinds.indexOf("element.update-description");
    // create must come before update
    expect(createIdx).toBeLessThan(updateIdx);
  });

  it("orders chapter creates before slice creates", async () => {
    setupSlice(root);
    const changes: FileChange[] = [
      { status: "A", path: `${SLICE_DIR}/slice.json` },
      { status: "A", path: `${CHAPTER_DIR}/chapter.json` },
    ];
    const ops = await buildOperations({ syncRootAbs: root, changes });
    const kinds = ops.map((o) => o.kind);
    expect(kinds.indexOf("chapter.create")).toBeLessThan(kinds.indexOf("slice.create"));
  });

  // ─── Element play-function update ─────────────────────────────────────────
  it("maps modified play-function.ts to element.update-config", async () => {
    setupElement(root);
    writeFile(root, `${ELEMENT_DIR}/play-function.ts`, "async function play() { return {}; }");
    const changes: FileChange[] = [
      { status: "M", path: `${ELEMENT_DIR}/play-function.ts` },
    ];
    const ops = await buildOperations({ syncRootAbs: root, changes });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "element.update-config",
      chapterId: CHAPTER_ID,
      elementId: ELEMENT_ID,
      playFunction: "async function play() { return {}; }",
    });
  });

  // ─── Generated files are skipped ──────────────────────────────────────────
  it("ignores index.md (generated)", async () => {
    setupChapter(root);
    const changes: FileChange[] = [
      { status: "M", path: `${CHAPTER_DIR}/index.md` },
    ];
    const ops = await buildOperations({ syncRootAbs: root, changes });
    expect(ops).toHaveLength(0);
  });

  // ─── Non-model paths are ignored ──────────────────────────────────────────
  it("ignores uuid-index.json", async () => {
    const changes: FileChange[] = [{ status: "M", path: "uuid-index.json" }];
    expect(await buildOperations({ syncRootAbs: root, changes })).toHaveLength(0);
  });

  it("ignores workspace.json", async () => {
    const changes: FileChange[] = [{ status: "M", path: "workspace.json" }];
    expect(await buildOperations({ syncRootAbs: root, changes })).toHaveLength(0);
  });

  // ─── Markdown content is read as-is ──────────────────────────────────────
  it("reads markdown content as-is from disk", async () => {
    setupElement(root);
    const changes: FileChange[] = [
      { status: "M", path: `${ELEMENT_DIR}/description.md` },
    ];
    const ops = await buildOperations({ syncRootAbs: root, changes });
    const op = ops[0] as { newDescription: string };
    expect(op.newDescription).toBe("Do something");
  });

  // ─── Element directory rename ──────────────────────────────────────────────
  it("element directory rename emits exactly one element.rename and no spurious move", async () => {
    // Simulate manually renaming the element folder (e.g. 0000_Plan-Todo → 0000_Create-Todo).
    // Git reports every file inside the renamed folder as an R (rename) change.
    // The bug was that handleRename emitted element.rename, then called handleAddOrModify
    // which processed element.json again and emitted a second element.rename + element.move.
    const OLD_ELEMENT_DIR = `${LANE_DIR}/elements/0000_Plan-Todo`;
    const NEW_ELEMENT_DIR = `${LANE_DIR}/elements/0000_Create-Todo`;

    // Write the NEW state on disk (element dir already renamed, element.json updated).
    setupLane(root);
    writeJson(root, `${NEW_ELEMENT_DIR}/element.json`, {
      id: ELEMENT_ID,
      type: "command",
      name: "Create Todo",
      context: "App",
      laneId: LANE_ID,
      sliceId: SLICE_ID,
      index: 0,
    });
    writeFile(root, `${NEW_ELEMENT_DIR}/description.md`, "Create a todo item");
    writeFile(root, `${NEW_ELEMENT_DIR}/details.md`, "Details here");
    writeFile(root, `${NEW_ELEMENT_DIR}/play-function.ts`, "async function play() {}");
    writeFile(root, `${NEW_ELEMENT_DIR}/play-type.ts`, "type Payload = { title: string }");

    // Git reports all files inside the folder as renames (R status).
    const changes: FileChange[] = [
      { status: "R", path: `${OLD_ELEMENT_DIR}/element.json`,      newPath: `${NEW_ELEMENT_DIR}/element.json` },
      { status: "R", path: `${OLD_ELEMENT_DIR}/description.md`,    newPath: `${NEW_ELEMENT_DIR}/description.md` },
      { status: "R", path: `${OLD_ELEMENT_DIR}/details.md`,        newPath: `${NEW_ELEMENT_DIR}/details.md` },
      { status: "R", path: `${OLD_ELEMENT_DIR}/play-function.ts`,  newPath: `${NEW_ELEMENT_DIR}/play-function.ts` },
      { status: "R", path: `${OLD_ELEMENT_DIR}/play-type.ts`,      newPath: `${NEW_ELEMENT_DIR}/play-type.ts` },
    ];

    const ops = await buildOperations({ syncRootAbs: root, changes });

    const renames = ops.filter((o) => o.kind === "element.rename");
    const moves   = ops.filter((o) => o.kind === "element.move");

    // Exactly one rename, no spurious move.
    expect(renames).toHaveLength(1);
    expect(renames[0]).toMatchObject({
      kind: "element.rename",
      chapterId: CHAPTER_ID,
      elementId: ELEMENT_ID,
      newName: "Create Todo",
    });
    expect(moves).toHaveLength(0);
  });

  // ─── Slice status update from slice.json ──────────────────────────────────
  it("emits slice.update-status when slice.json is modified", async () => {
    setupSlice(root);
    // Update slice.json to planned status
    writeJson(root, `${SLICE_DIR}/slice.json`, {
      id: SLICE_ID,
      label: "My Slice",
      index: 0,
      status: "planned",
    });
    const changes: FileChange[] = [
      { status: "M", path: `${SLICE_DIR}/slice.json` },
    ];
    const ops = await buildOperations({ syncRootAbs: root, changes });
    const statusOp = ops.find((o) => o.kind === "slice.update-status");
    expect(statusOp).toMatchObject({
      kind: "slice.update-status",
      sliceId: SLICE_ID,
      newStatus: "planned",
    });
  });
});
