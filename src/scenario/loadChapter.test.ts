import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "../sync/render.js";
import { writeTree } from "../sync/writer.js";
import { seedModelFromData } from "../sync/seed.js";
import type { ApiChapter } from "../sync/restClient.js";
import { loadChapterFromDisk, resolveChapterDir } from "./loadChapter.js";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeApiChapter(overrides: Partial<ApiChapter> = {}): ApiChapter {
  return {
    id: "chap-1",
    name: "Todo App",
    context: "App",
    mode: "event-modeling",
    index: 0,
    lanes: [
      { id: "lane-user", label: "User", type: "user-lane", index: 0 },
      { id: "lane-info", label: "Info Flow", type: "information-flow", index: 1 },
      { id: "lane-sys",  label: "System",   type: "system",           index: 2 },
    ] as Record<string, unknown>[],
    slices: [
      { id: "slice-0", label: "Add Todo", index: 0 },
      { id: "slice-1", label: "List Todos", index: 1 },
    ] as Record<string, unknown>[],
    elements: [
      {
        id: "el-ui",  type: "ui",      name: "Add Todo Form",  context: "App",
        laneId: "lane-user", sliceId: "slice-0", index: 0,
      },
      {
        id: "el-cmd", type: "command", name: "Add Todo",       context: "App",
        laneId: "lane-info", sliceId: "slice-0", index: 0,
        playFunction: "decide({ name }) { emit('TodoAdded', { name }); }",
      },
      {
        id: "el-evt", type: "event",   name: "Todo Added",     context: "App",
        laneId: "lane-sys",  sliceId: "slice-0", index: 0,
        playType: "{ name: string }",
      },
      {
        id: "el-info", type: "information", name: "Todo List", context: "App",
        laneId: "lane-info", sliceId: "slice-1", index: 0,
        playFunction: "read(state) { return state.todos ?? []; }",
      },
    ] as Record<string, unknown>[],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test setup
// ─────────────────────────────────────────────────────────────────────────────

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "spec-stream-loadChapter-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function buildAndWrite(chapter: ApiChapter = makeApiChapter()): string {
  const state = seedModelFromData("ws-1", "Test WS", [chapter], []);
  const tree = render(state);
  writeTree(root, tree);
  return root;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("loadChapterFromDisk", () => {
  it("reconstructs chapter id, name, context, mode", async () => {
    buildAndWrite();
    const chapterDir = await resolveChapterDir(root, "chap-1");
    const chapter = await loadChapterFromDisk(chapterDir);

    expect(chapter.id).toBe("chap-1");
    expect(chapter.name).toBe("Todo App");
    expect(chapter.context).toBe("App");
    expect(chapter.mode).toBe("event-modeling");
  });

  it("reconstructs all slices in index order", async () => {
    buildAndWrite();
    const chapterDir = await resolveChapterDir(root, "chap-1");
    const chapter = await loadChapterFromDisk(chapterDir);

    expect(chapter.slices).toHaveLength(2);
    expect(chapter.slices[0]!.id).toBe("slice-0");
    expect(chapter.slices[0]!.label).toBe("Add Todo");
    expect(chapter.slices[1]!.id).toBe("slice-1");
    expect(chapter.slices[1]!.label).toBe("List Todos");
    // Must be index-ordered
    expect(chapter.slices[0]!.index).toBeLessThan(chapter.slices[1]!.index);
  });

  it("reconstructs all lanes (de-duplicated by id)", async () => {
    buildAndWrite();
    const chapterDir = await resolveChapterDir(root, "chap-1");
    const chapter = await loadChapterFromDisk(chapterDir);

    const laneIds = chapter.lanes.map((l) => l.id);
    // De-duplicated — each lane should appear exactly once
    expect(new Set(laneIds).size).toBe(laneIds.length);
    expect(laneIds).toContain("lane-user");
    expect(laneIds).toContain("lane-info");
    expect(laneIds).toContain("lane-sys");
  });

  it("reconstructs all elements with correct laneId/sliceId/index", async () => {
    buildAndWrite();
    const chapterDir = await resolveChapterDir(root, "chap-1");
    const chapter = await loadChapterFromDisk(chapterDir);

    expect(chapter.elements).toHaveLength(4);

    const cmd = chapter.elements.find((e) => e.id === "el-cmd");
    expect(cmd).toBeDefined();
    expect(cmd!.laneId).toBe("lane-info");
    expect(cmd!.sliceId).toBe("slice-0");
    expect(cmd!.index).toBe(0);
    expect(cmd!.type).toBe("command");
    expect(cmd!.name).toBe("Add Todo");
  });

  it("attaches playFunction for elements that have one", async () => {
    buildAndWrite();
    const chapterDir = await resolveChapterDir(root, "chap-1");
    const chapter = await loadChapterFromDisk(chapterDir);

    const cmd = chapter.elements.find((e) => e.id === "el-cmd");
    expect(cmd!.playFunction).toBeTruthy();
    expect(cmd!.playFunction).toContain("emit");

    const ui = chapter.elements.find((e) => e.id === "el-ui");
    expect(ui!.playFunction).toBeUndefined();
  });

  it("attaches playType as the bare expression (without the 'type Payload =' wrapper)", async () => {
    buildAndWrite();
    const chapterDir = await resolveChapterDir(root, "chap-1");
    const chapter = await loadChapterFromDisk(chapterDir);

    const evt = chapter.elements.find((e) => e.id === "el-evt");
    expect(evt!.playType).toBeDefined();
    // The bare expression — not "type Payload = ..."
    expect(evt!.playType).not.toMatch(/type Payload/);
    expect(evt!.playType).toContain("name");
  });

  it("element without playType has playType undefined", async () => {
    buildAndWrite();
    const chapterDir = await resolveChapterDir(root, "chap-1");
    const chapter = await loadChapterFromDisk(chapterDir);

    const ui = chapter.elements.find((e) => e.id === "el-ui");
    expect(ui!.playType).toBeUndefined();
  });
});

describe("resolveChapterDir", () => {
  it("resolves a chapter UUID from uuid-index.json", async () => {
    buildAndWrite();
    const chapterDir = await resolveChapterDir(root, "chap-1");

    // Should be a path inside the chapters/ subtree
    expect(chapterDir).toContain("chapters");
    // The chapter.json should be readable from the resolved dir
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(chapterDir, "chapter.json"), "utf8");
    const json = JSON.parse(raw);
    expect(json.id).toBe("chap-1");
  });

  it("passes through an absolute path unchanged", async () => {
    buildAndWrite();
    // Find the real chapter dir via UUID first, then pass it as absolute path
    const chapterDir = await resolveChapterDir(root, "chap-1");
    const same = await resolveChapterDir(root, chapterDir);
    expect(same).toBe(chapterDir);
  });

  it("loads a complete chapter after resolution", async () => {
    buildAndWrite();
    const chapterDir = await resolveChapterDir(root, "chap-1");
    const chapter = await loadChapterFromDisk(chapterDir);
    expect(chapter.id).toBe("chap-1");
    expect(chapter.elements.length).toBeGreaterThan(0);
  });
});
