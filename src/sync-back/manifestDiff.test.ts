import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeManifestDiff, computeDiskHash } from "./manifestDiff.js";
import { saveManifest, syncManifestPath, syncBackIdsPath, type SyncManifest } from "./manifest.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRoot(): string {
  const dir = join(tmpdir(), `spec-stream-manifestdiff-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  // model dir is one level below the .spec-stream dir
  mkdirSync(join(dir, "model"), { recursive: true });
  return join(dir, "model");
}

function writeJson(root: string, relPath: string, data: unknown): void {
  const abs = join(root, relPath);
  mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  writeFileSync(abs, JSON.stringify(data, null, 2), "utf8");
}

function writeManifest(root: string, entities: Record<string, { id: string; hash?: string }>): void {
  const manifest: SyncManifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    entities,
  };
  saveManifest(syncManifestPath(root), manifest);
}

const CHAPTER_DIR  = "chapters/App/My-Chapter";
const SLICE_DIR    = `${CHAPTER_DIR}/slices/0001_My-Slice`;
const LANE_DIR     = `${SLICE_DIR}/lanes/information-flow/My-Lane`;
const ELEMENT_DIR  = `${LANE_DIR}/elements/0001_My-Element`;
const MILESTONE_DIR = "milestones/My-Milestone";

const CHAPTER_ID  = "chapter-uuid-1";
const SLICE_ID    = "slice-uuid-1";
const LANE_ID     = "lane-uuid-1";
const ELEMENT_ID  = "element-uuid-1";
const MILESTONE_ID = "milestone-uuid-1";

function writeFullModel(root: string): void {
  writeJson(root, `${CHAPTER_DIR}/chapter.json`,   { id: CHAPTER_ID,  name: "My Chapter",  context: "App" });
  writeJson(root, `${SLICE_DIR}/slice.json`,        { id: SLICE_ID,    label: "My Slice" });
  writeJson(root, `${LANE_DIR}/lane.json`,          { id: LANE_ID,     label: "My Lane", type: "information-flow" });
  writeJson(root, `${ELEMENT_DIR}/element.json`,    { id: ELEMENT_ID,  name: "My Element", type: "command", laneId: LANE_ID, sliceId: SLICE_ID });
  writeJson(root, `${MILESTONE_DIR}/milestone.json`,{ id: MILESTONE_ID, name: "My Milestone" });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("computeManifestDiff", () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => { rmSync(join(root, ".."), { recursive: true, force: true }); });

  it("returns creates for all entities when no manifest exists", () => {
    writeFullModel(root);
    const diffs = computeManifestDiff({ syncRootAbs: root });
    expect(diffs.length).toBeGreaterThanOrEqual(5);
    expect(diffs.every((d) => d.status === "create")).toBe(true);
  });

  it("returns updates for entities present in manifest and on disk", () => {
    writeFullModel(root);
    writeManifest(root, {
      [CHAPTER_DIR]:   { id: CHAPTER_ID },
      [SLICE_DIR]:     { id: SLICE_ID },
      [LANE_DIR]:      { id: LANE_ID },
      [ELEMENT_DIR]:   { id: ELEMENT_ID },
      [MILESTONE_DIR]: { id: MILESTONE_ID },
    });
    const diffs = computeManifestDiff({ syncRootAbs: root });
    expect(diffs.every((d) => d.status === "update")).toBe(true);
    expect(diffs.find((d) => d.entityDir === ELEMENT_DIR)).toMatchObject({
      status: "update", entityDir: ELEMENT_DIR, kind: "element", id: ELEMENT_ID,
    });
  });

  it("returns delete for entities in manifest but missing from disk", () => {
    writeFullModel(root);
    writeManifest(root, {
      [CHAPTER_DIR]:   { id: CHAPTER_ID },
      [SLICE_DIR]:     { id: SLICE_ID },
      [LANE_DIR]:      { id: LANE_ID },
      [ELEMENT_DIR]:   { id: ELEMENT_ID },
      [MILESTONE_DIR]: { id: MILESTONE_ID },
      // Extra entry in manifest that has no corresponding dir on disk:
      "chapters/App/My-Chapter/slices/0001_My-Slice/lanes/information-flow/My-Lane/elements/0002_Old-Element": { id: "old-element-uuid" },
    });
    const diffs = computeManifestDiff({ syncRootAbs: root });
    const deletes = diffs.filter((d) => d.status === "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({
      status: "delete",
      kind: "element",
      id: "old-element-uuid",
    });
  });

  it("detects rename when same id appears under a different dir", () => {
    // On disk: element exists under NEW_DIR (id = ELEMENT_ID)
    // Manifest: element was under OLD_DIR (same id)
    const OLD_DIR = `${LANE_DIR}/elements/0001_Old-Name`;
    const NEW_DIR = `${LANE_DIR}/elements/0001_New-Name`;

    writeJson(root, `${CHAPTER_DIR}/chapter.json`,   { id: CHAPTER_ID,  name: "My Chapter", context: "App" });
    writeJson(root, `${SLICE_DIR}/slice.json`,        { id: SLICE_ID,    label: "My Slice" });
    writeJson(root, `${LANE_DIR}/lane.json`,          { id: LANE_ID,     label: "My Lane", type: "information-flow" });
    writeJson(root, `${NEW_DIR}/element.json`,        { id: ELEMENT_ID,  name: "New Name", type: "command", laneId: LANE_ID, sliceId: SLICE_ID });

    writeManifest(root, {
      [CHAPTER_DIR]: { id: CHAPTER_ID },
      [SLICE_DIR]:   { id: SLICE_ID },
      [LANE_DIR]:    { id: LANE_ID },
      [OLD_DIR]:     { id: ELEMENT_ID },   // old location in manifest
    });

    const diffs = computeManifestDiff({ syncRootAbs: root });
    const renames = diffs.filter((d) => d.status === "rename");
    expect(renames).toHaveLength(1);
    expect(renames[0]).toMatchObject({
      status: "rename",
      entityDir: NEW_DIR,
      kind: "element",
      id: ELEMENT_ID,
      oldEntityDir: OLD_DIR,
    });
    // OLD_DIR should not also appear as a delete
    const deletes = diffs.filter((d) => d.status === "delete");
    expect(deletes.some((d) => d.entityDir === OLD_DIR)).toBe(false);
  });

  it("treats entity with id already in sync-back-ids as update not create", () => {
    // Simulates: sync-back created an entity, wrote its id to sync-back-ids.json,
    // but sync has not yet processed the board event. Without sync-back-ids, the
    // next run would see the dir not in sync-manifest and emit a spurious create.
    writeFullModel(root);

    // sync-manifest is empty (sync hasn't run yet)
    writeManifest(root, {});

    // sync-back-ids has the ids from the last run
    const backIds: SyncManifest = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entities: {
        [ELEMENT_DIR]: { id: ELEMENT_ID },
      },
    };
    saveManifest(syncBackIdsPath(root), backIds);

    const diffs = computeManifestDiff({ syncRootAbs: root });
    const elementDiff = diffs.find((d) => d.entityDir === ELEMENT_DIR);
    // With id in sync-back-ids the dir is "known" → update, not create
    expect(elementDiff?.status).toBe("update");
    expect(diffs.filter((d) => d.status === "create" && d.entityDir === ELEMENT_DIR)).toHaveLength(0);
  });

  it("returns empty array when model dir is empty and manifest is empty", () => {
    const diffs = computeManifestDiff({ syncRootAbs: root });
    expect(diffs).toHaveLength(0);
  });

  it("skips entities whose disk hash matches the manifest hash (unchanged content)", () => {
    writeFullModel(root);
    // Compute the hash the same way manifestDiff does — then store it in the manifest.
    const elemHash = computeDiskHash(root, ELEMENT_DIR, "element");
    writeManifest(root, {
      [CHAPTER_DIR]:   { id: CHAPTER_ID },
      [SLICE_DIR]:     { id: SLICE_ID },
      [LANE_DIR]:      { id: LANE_ID },
      [ELEMENT_DIR]:   { id: ELEMENT_ID, hash: elemHash },
      [MILESTONE_DIR]: { id: MILESTONE_ID },
    });
    const diffs = computeManifestDiff({ syncRootAbs: root });
    // The element with a matching hash should be skipped.
    expect(diffs.find((d) => d.entityDir === ELEMENT_DIR)).toBeUndefined();
    // Entities with no hash in the manifest should still appear as updates.
    expect(diffs.find((d) => d.entityDir === CHAPTER_DIR)).toMatchObject({ status: "update" });
  });

  it("returns update for entities whose disk hash differs from the manifest hash", () => {
    writeFullModel(root);
    // Write a stale hash that won't match the current disk content.
    writeManifest(root, {
      [ELEMENT_DIR]: { id: ELEMENT_ID, hash: "00000000" }, // wrong hash
    });
    const diffs = computeManifestDiff({ syncRootAbs: root });
    const elementDiff = diffs.find((d) => d.entityDir === ELEMENT_DIR);
    expect(elementDiff?.status).toBe("update");
  });
});
