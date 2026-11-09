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

const CHAPTER_ID  = "chapter-uuid-1";
const SLICE_ID    = "slice-uuid-1";
const LANE_ID     = "lane-uuid-1";
const ELEMENT_ID  = "element-uuid-1";
const MILESTONE_ID = "milestone-uuid-1";

const CHAPTER_DIR  = `chapters/${CHAPTER_ID}`;
const SLICE_DIR    = `${CHAPTER_DIR}/slices/${SLICE_ID}`;
const LANE_DIR     = `${CHAPTER_DIR}/lanes/${LANE_ID}`;
const ELEMENT_DIR  = `${CHAPTER_DIR}/elements/${ELEMENT_ID}`;
const MILESTONE_DIR = `milestones/${MILESTONE_ID}`;

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
      [`${CHAPTER_DIR}/elements/old-element-uuid`]: { id: "old-element-uuid" },
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

  it("never emits rename — all entity dirs are UUID-keyed", () => {
    // All directories are now UUID-keyed (including milestones). Directory paths never
    // change, so renames/moves always surface as content changes ("update" diffs).
    writeFullModel(root);
    writeManifest(root, {
      [CHAPTER_DIR]:   { id: CHAPTER_ID },
      [SLICE_DIR]:     { id: SLICE_ID },
      [LANE_DIR]:      { id: LANE_ID },
      [ELEMENT_DIR]:   { id: ELEMENT_ID },
      [MILESTONE_DIR]: { id: MILESTONE_ID },
    });

    const diffs = computeManifestDiff({ syncRootAbs: root });
    expect(diffs.filter((d) => d.status === "rename")).toHaveLength(0);
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

  it("does NOT emit a spurious delete when sync renames a directory that sync-back had recorded under the old name", () => {
    // Reproduces the bug described in the issue:
    //
    // 1. Agent edits element.json: changes `name` field (directory is still OLD_DIR).
    // 2. sync-back run #1: detects UPDATE, calls element.rename API, writes to
    //    sync-back-ids.json under OLD_DIR.
    // 3. Local sync processes the element-renamed event from the board, renames the
    //    directory to NEW_DIR, and updates sync-manifest.json to use NEW_DIR as key.
    // 4. sync-back run #2 should NOT emit a delete for OLD_DIR.

    const OLD_ELEMENT_DIR = `${CHAPTER_DIR}/elements/old-lead-created-uuid`;
    const NEW_ELEMENT_DIR = `${CHAPTER_DIR}/elements/new-lead-registered-uuid`;

    // State after step 3: disk has NEW_DIR, sync-manifest has NEW_DIR.
    writeJson(root, `${CHAPTER_DIR}/chapter.json`,     { id: CHAPTER_ID, name: "My Chapter", context: "App" });
    writeJson(root, `${SLICE_DIR}/slice.json`,          { id: SLICE_ID,   label: "My Slice" });
    writeJson(root, `${LANE_DIR}/lane.json`,            { id: LANE_ID,    label: "My Lane", type: "information-flow" });
    writeJson(root, `${NEW_ELEMENT_DIR}/element.json`,  { id: ELEMENT_ID, name: "Lead Registered", type: "event", laneId: LANE_ID, sliceId: SLICE_ID });

    // sync-manifest.json (written by sync): tracks the NEW directory.
    writeManifest(root, {
      [CHAPTER_DIR]:     { id: CHAPTER_ID },
      [SLICE_DIR]:       { id: SLICE_ID },
      [LANE_DIR]:        { id: LANE_ID },
      [NEW_ELEMENT_DIR]: { id: ELEMENT_ID },
    });

    // sync-back-ids.json (written by sync-back run #1): still has the OLD directory.
    const backIds: SyncManifest = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entities: {
        [OLD_ELEMENT_DIR]: { id: ELEMENT_ID, hash: "oldhash" },
      },
    };
    saveManifest(syncBackIdsPath(root), backIds);

    const diffs = computeManifestDiff({ syncRootAbs: root });

    // The OLD_DIR must NOT appear as a delete.
    const deletes = diffs.filter((d) => d.status === "delete");
    expect(deletes.some((d) => d.entityDir === OLD_ELEMENT_DIR)).toBe(false);

    // The element should appear as an update (or be skipped if hash matches) under NEW_DIR.
    const elementDiff = diffs.find((d) => d.entityDir === NEW_ELEMENT_DIR);
    expect(elementDiff).toBeDefined();
    expect(elementDiff?.status).not.toBe("delete");
    expect(elementDiff?.id).toBe(ELEMENT_ID);
  });

  it("does NOT emit a delete for an entity that was deleted externally (sync removed it from sync-manifest and disk)", async () => {
    // Scenario: an entity (e.g. scenario, element) was deleted on the board.
    // sync processed the deletion event → removed the local file AND removed the
    // entry from sync-manifest.json. But sync-back-ids.json still holds the old
    // entry (written by a previous sync-back create). On the next sync-back run
    // the entry appears in the merged manifest but not on disk and not in
    // sync-manifest — this must NOT produce a delete operation.

    const SCENARIO_ID  = "scenario-uuid-deleted";
    const SCENARIO_DIR = `${CHAPTER_DIR}/scenarios/Deleted-Scenario`;

    writeJson(root, `${CHAPTER_DIR}/chapter.json`, { id: CHAPTER_ID, name: "My Chapter", context: "App" });

    // sync-manifest.json: the scenario is GONE (sync already processed the deletion).
    writeManifest(root, {
      [CHAPTER_DIR]: { id: CHAPTER_ID },
    });

    // sync-back-ids.json: still has the scenario from a previous create run.
    const backIds: SyncManifest = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entities: {
        [SCENARIO_DIR]: { id: SCENARIO_ID, hash: "oldhash" },
      },
    };
    saveManifest(syncBackIdsPath(root), backIds);

    // Disk: no scenario.json — sync already deleted it.

    const diffs = computeManifestDiff({ syncRootAbs: root });

    const deletes = diffs.filter((d) => d.status === "delete");
    expect(deletes.some((d) => d.entityDir === SCENARIO_DIR)).toBe(false);
    expect(deletes.some((d) => d.id === SCENARIO_ID)).toBe(false);
  });

  it("emits update when a content file tracked only via sync-back-ids was deleted (hash matches)", () => {
    // Reproduces the play-function.ts resurrection bug:
    // sync-back pushed play-function.ts and recorded its hash in
    // sync-back-ids.json, but sync-manifest.json — written before the file
    // existed and not rewritten since — holds an entry whose entity hash
    // matches the post-deletion disk state exactly. Without the contentHashes
    // union and the missing-file check, the deletion is silently skipped.
    writeFullModel(root);
    const elemHash = computeDiskHash(root, ELEMENT_DIR, "element");
    writeManifest(root, {
      [ELEMENT_DIR]: { id: ELEMENT_ID, hash: elemHash },
    });

    // sync-back-ids has the newer snapshot including play-function.ts.
    const backIds: SyncManifest = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entities: {
        [ELEMENT_DIR]: { id: ELEMENT_ID, hash: "otherhash", contentHashes: { "play-function.ts": "deadbeef" } },
      },
    };
    saveManifest(syncBackIdsPath(root), backIds);

    const diffs = computeManifestDiff({ syncRootAbs: root });
    const elementDiff = diffs.find((d) => d.entityDir === ELEMENT_DIR);
    expect(elementDiff?.status).toBe("update");
    // The merged contentHashes must surface the sync-back-ids-only entry so
    // operationBuilder can recognise the deletion.
    expect(elementDiff?.oldContentHashes?.["play-function.ts"]).toBe("deadbeef");
  });

  it("skips an entity whose sync-back-ids entry supersedes an unchanged sync-manifest entry", () => {
    // Reproduces the stale-manifest re-update bug:
    // sync-back pushed a rename and wrote a fresh entry (current disk hash) into
    // sync-back-ids.json, recording the sync-manifest hash it superseded as
    // baseHash. sync has not run since, so sync-manifest.json still holds the
    // stale pre-push entry. Without baseHash the stale sync-manifest entry would
    // win the merge and the same update would be re-emitted on every run.
    writeFullModel(root);
    const diskHash = computeDiskHash(root, ELEMENT_DIR, "element");
    writeManifest(root, {
      [ELEMENT_DIR]: { id: ELEMENT_ID, hash: "stale-hash" }, // pre-push state
    });
    saveManifest(syncBackIdsPath(root), {
      version: 1,
      updatedAt: new Date().toISOString(),
      entities: {
        [ELEMENT_DIR]: { id: ELEMENT_ID, hash: diskHash, baseHash: "stale-hash" },
      },
    });

    const diffs = computeManifestDiff({ syncRootAbs: root });
    expect(diffs.find((d) => d.entityDir === ELEMENT_DIR)).toBeUndefined();
  });

  it("lets sync-manifest win once it advanced past the recorded baseHash", () => {
    // Same setup, but sync HAS pulled newer board state since the push: the
    // sync-manifest hash no longer matches the recorded baseHash, so the
    // sync-back-ids entry is stale and must not shadow the newer manifest entry.
    writeFullModel(root);
    writeManifest(root, {
      [ELEMENT_DIR]: {
        id: ELEMENT_ID,
        hash: "board-hash",
        fields: { name: "Board Name" },
      },
    });
    saveManifest(syncBackIdsPath(root), {
      version: 1,
      updatedAt: new Date().toISOString(),
      entities: {
        [ELEMENT_DIR]: {
          id: ELEMENT_ID,
          hash: computeDiskHash(root, ELEMENT_DIR, "element"),
          baseHash: "stale-hash", // superseded hash — does NOT match "board-hash"
          fields: { name: "Old Pushed Name" },
        },
      },
    });

    const diffs = computeManifestDiff({ syncRootAbs: root });
    const elementDiff = diffs.find((d) => d.entityDir === ELEMENT_DIR);
    // Disk differs from the newer manifest hash → update diff…
    expect(elementDiff?.status).toBe("update");
    // …and the diff must carry the sync-manifest fields, not the stale ones.
    expect(elementDiff?.oldFields?.name).toBe("Board Name");
  });

  it("does NOT emit a delete for a manifest entry whose dir was pushed under a board-assigned id", () => {
    // Reproduces the scenario-uuid-duplicates bug:
    //   1. Scenario created locally under a client-generated UUID (LOCAL_ID).
    //   2. sync-back created it on the board — which assigned BOARD_ID — and
    //      recorded `scenarios/LOCAL_ID → BOARD_ID` in sync-back-ids.json.
    //   3. The sync daemon later wrote the canonical `scenarios/BOARD_ID` dir
    //      and a sync-manifest entry for it — while a resume-load also put a
    //      sync-manifest entry `scenarios/LOCAL_ID → LOCAL_ID` (the local file
    //      still carried the client id).
    //   4. The user deletes the stale `scenarios/LOCAL_ID` dir.
    // Without the alias guard the LOCAL_ID manifest entry produces
    // `DELETE /scenarios/LOCAL_ID` for an id that never existed on the board
    // → HTTP 500 → failed run → stale sync-back-lock.
    const LOCAL_ID = "scenario-local-uuid";
    const BOARD_ID = "scenario-board-uuid";
    const LOCAL_DIR = `${CHAPTER_DIR}/scenarios/${LOCAL_ID}`;
    const BOARD_DIR = `${CHAPTER_DIR}/scenarios/${BOARD_ID}`;

    // Disk: only the canonical board-id dir remains.
    writeJson(root, `${CHAPTER_DIR}/chapter.json`, { id: CHAPTER_ID, name: "My Chapter", context: "App" });
    writeJson(root, `${BOARD_DIR}/scenario.json`, { id: BOARD_ID, chapterId: CHAPTER_ID, name: "My Scenario" });

    // sync-manifest tracks BOTH dirs (resume rendered the alias file too).
    writeManifest(root, {
      [CHAPTER_DIR]: { id: CHAPTER_ID },
      [LOCAL_DIR]:   { id: LOCAL_ID },
      [BOARD_DIR]:   { id: BOARD_ID },
    });

    // sync-back-ids records that the LOCAL_ID dir was pushed as BOARD_ID.
    saveManifest(syncBackIdsPath(root), {
      version: 1,
      updatedAt: new Date().toISOString(),
      entities: {
        [LOCAL_DIR]: { id: BOARD_ID },
      },
    });

    const diffs = computeManifestDiff({ syncRootAbs: root });
    const deletes = diffs.filter((d) => d.status === "delete");
    expect(deletes.some((d) => d.entityDir === LOCAL_DIR)).toBe(false);
    expect(deletes.some((d) => d.id === LOCAL_ID)).toBe(false);
    expect(deletes).toHaveLength(0);
  });

  it("emits a single delete for the board id when alias and canonical dirs are both missing", () => {
    // Same alias setup, but the user deleted BOTH dirs (intended: delete the
    // board entity). The board-side entity must be deleted exactly once under
    // its real id — not twice, and never under the client alias id.
    const LOCAL_ID = "scenario-local-uuid";
    const BOARD_ID = "scenario-board-uuid";
    const LOCAL_DIR = `${CHAPTER_DIR}/scenarios/${LOCAL_ID}`;
    const BOARD_DIR = `${CHAPTER_DIR}/scenarios/${BOARD_ID}`;

    writeJson(root, `${CHAPTER_DIR}/chapter.json`, { id: CHAPTER_ID, name: "My Chapter", context: "App" });

    writeManifest(root, {
      [CHAPTER_DIR]: { id: CHAPTER_ID },
      [LOCAL_DIR]:   { id: LOCAL_ID },
      [BOARD_DIR]:   { id: BOARD_ID },
    });
    saveManifest(syncBackIdsPath(root), {
      version: 1,
      updatedAt: new Date().toISOString(),
      entities: {
        [LOCAL_DIR]: { id: BOARD_ID },
      },
    });

    const diffs = computeManifestDiff({ syncRootAbs: root });
    const deletes = diffs.filter((d) => d.status === "delete");
    expect(deletes.filter((d) => d.id === BOARD_ID)).toHaveLength(1);
    expect(deletes.some((d) => d.id === LOCAL_ID)).toBe(false);
  });

  it("still skips unchanged entities when every tracked content file exists on disk", () => {
    writeFullModel(root);
    // A tracked content file that still exists must not defeat the hash-match skip.
    writeFileSync(join(root, ELEMENT_DIR, "description.md"), "hello", "utf8");
    const elemHash = computeDiskHash(root, ELEMENT_DIR, "element");
    const manifest: SyncManifest = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entities: {
        [ELEMENT_DIR]: { id: ELEMENT_ID, hash: elemHash, contentHashes: { "description.md": "deadbeef" } },
      },
    };
    saveManifest(syncManifestPath(root), manifest);
    const diffs = computeManifestDiff({ syncRootAbs: root });
    expect(diffs.find((d) => d.entityDir === ELEMENT_DIR)).toBeUndefined();
  });

  it("surfaces an update when a tracked task comment was removed (hash unchanged)", () => {
    writeFullModel(root);
    // Element hash matches, but the manifest knows about a task comment that is now
    // gone from disk (the comments/ dir is excluded from the entity hash).
    const elemHash = computeDiskHash(root, ELEMENT_DIR, "element");
    const manifest: SyncManifest = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entities: {
        [ELEMENT_DIR]: { id: ELEMENT_ID, hash: elemHash, extra: { comments: [{ id: "cm-task", isTask: true }] } },
      },
    };
    saveManifest(syncManifestPath(root), manifest);
    const diff = computeManifestDiff({ syncRootAbs: root }).find((d) => d.entityDir === ELEMENT_DIR);
    expect(diff).toMatchObject({ status: "update", entityDir: ELEMENT_DIR });
    expect(diff?.oldComments).toEqual([{ id: "cm-task", isTask: true }]);
  });

  it("does not surface an update when comments are unchanged (hash match)", () => {
    writeFullModel(root);
    // Write the same comment on disk that the manifest records.
    writeJson(root, `${ELEMENT_DIR}/comments/2026-01-01_cm1/comment.json`, { id: "cm1", createdAt: "2026-01-01", isTask: true });
    writeFileSync(join(root, ELEMENT_DIR, "comments/2026-01-01_cm1/comment.md"), "body", "utf8");
    const elemHash = computeDiskHash(root, ELEMENT_DIR, "element");
    const manifest: SyncManifest = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entities: {
        [ELEMENT_DIR]: { id: ELEMENT_ID, hash: elemHash, extra: { comments: [{ id: "cm1", isTask: true }] } },
      },
    };
    saveManifest(syncManifestPath(root), manifest);
    const diffs = computeManifestDiff({ syncRootAbs: root });
    expect(diffs.find((d) => d.entityDir === ELEMENT_DIR)).toBeUndefined();
  });
});
