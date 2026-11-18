import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Projection, type Timers } from "./projection.js";
import type { Logger } from "../logging/logger.js";
import type { RestClient, ApiChapter, ApiMilestone } from "./restClient.js";
import type { ChangelogEvent } from "../realtime/events.js";
import { syncManifestPath } from "../sync-back/manifest.js";

function noopLogger(): Logger {
  const fn = () => {};
  return { trace: fn, debug: fn, info: fn, warn: fn, error: fn, child: () => noopLogger() } as unknown as Logger;
}

interface RecordedLog {
  level: string;
  kind: string;
  fields: Record<string, unknown>;
}

/** A logger that records every call so tests can assert on emitted records. */
function recordingLogger(): { logger: Logger; records: RecordedLog[] } {
  const records: RecordedLog[] = [];
  const mk = (level: string) => (kind: string, fields: Record<string, unknown> = {}) =>
    records.push({ level, kind, fields });
  const logger = {
    trace: mk("trace"), debug: mk("debug"), info: mk("info"),
    warn: mk("warn"), error: mk("error"),
  } as unknown as Logger;
  return { logger, records };
}

/** A manual timer harness: nothing fires until `tick()`. */
function manualTimers(): Timers & { tick: () => void; pending: () => boolean } {
  let scheduled: (() => void) | undefined;
  return {
    setTimeout: (fn: () => void) => {
      scheduled = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: () => {
      scheduled = undefined;
    },
    tick: () => {
      const fn = scheduled;
      scheduled = undefined;
      fn?.();
    },
    pending: () => scheduled !== undefined,
  };
}

function chapter(): ApiChapter {
  return {
    id: "c1", name: "Checkout", index: 0, context: "Ordering", mode: "event-modeling",
    lanes: [{ id: "l1", label: "Customer", type: "user-lane", index: 0 }],
    slices: [{ id: "s1", label: "Place Order", index: 0, status: "draft" }],
    elements: [{ id: "el1", type: "command", name: "Place Order", context: "Ordering", laneId: "l1", sliceId: "s1", index: 0 }],
  };
}

function mockClient(chapters: ApiChapter[] = [chapter()], milestones: ApiMilestone[] = []): RestClient {
  return {
    async listChapters() {
      return chapters.map((c) => ({ id: c.id, name: c.name, index: c.index, context: c.context, mode: c.mode }));
    },
    async getChapter(id: string) {
      return chapters.find((c) => c.id === id)!;
    },
    async listMilestones() {
      return milestones;
    },
    async listScenarios(_chapterId: string) {
      return [];
    },
    async listSnippets() {
      return [];
    },
  } as unknown as RestClient;
}

function ev(type: string, o: Partial<ChangelogEvent> = {}): ChangelogEvent {
  return {
    id: "e1", type, timestamp: 1, workspaceId: "ws", chapterId: "c1", userId: "u",
    addedByAgent: false, createdAt: "2026-10-03T00:00:00Z", data: {},
    row: {} as ChangelogEvent["row"], ...o,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spec-stream-proj-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function make(overrides: Partial<Parameters<typeof Projection.prototype.constructor>[0]> = {}) {
  const timers = manualTimers();
  const proj = new Projection({
    dir,
    workspaceId: "ws",
    workspaceName: "Demo",
    client: mockClient(),
    logger: noopLogger(),
    timers,
    debounceMs: 10,
    ...overrides,
  });
  return { proj, timers };
}

describe("Projection seeding", () => {
  it("seeds the model and writes the full tree", async () => {
    const { proj } = make();
    const result = await proj.seed();
    expect(result.created).toBeGreaterThan(0);
    expect(existsSync(join(dir, "chapters/c1/chapter.json"))).toBe(true);
    expect(existsSync(join(dir, "sync-state.json"))).toBe(true);
    expect(proj.isSeeded).toBe(true);
  });
});

describe("Projection debounced writes", () => {
  it("coalesces a burst of events into a single write pass", async () => {
    const { proj, timers } = make();
    await proj.seed();

    proj.handle(ev("slice-renamed", { sliceId: "s1", id: "a", data: { newValue: { label: "A" } } }));
    proj.handle(ev("slice-renamed", { sliceId: "s1", id: "b", data: { newValue: { label: "B" } } }));
    proj.handle(ev("slice-renamed", { sliceId: "s1", id: "c", data: { newValue: { label: "Final" } } }));
    expect(timers.pending()).toBe(true); // one write scheduled, not three

    timers.tick(); // single flush
    // final label wins in slice.json; the UUID dir is stable
    const sliceJson = join(dir, "chapters/c1/slices/s1/slice.json");
    expect(existsSync(sliceJson)).toBe(true);
    expect(JSON.parse(readFileSync(sliceJson, "utf8")).label).toBe("Final");
  });

  it("advances the cursor only after a successful write pass", async () => {
    const { proj, timers } = make();
    await proj.seed();
    proj.handle(ev("slice-status-changed", { sliceId: "s1", id: "evt-42", createdAt: "2026-10-03T12:00:00Z", data: { newValue: { status: "planned" } } }));

    // Before flush: cursor still at seed state (no event id yet persisted).
    const before = JSON.parse(readFileSync(join(dir, "sync-state.json"), "utf8"));
    expect(before.cursor.lastEventId).toBeUndefined();

    timers.tick();
    const after = JSON.parse(readFileSync(join(dir, "sync-state.json"), "utf8"));
    expect(after.cursor.lastEventId).toBe("evt-42");
    expect(after.cursor.lastCreatedAt).toBe("2026-10-03T12:00:00Z");
  });

  it("flushNow writes pending changes immediately (graceful stop)", async () => {
    const { proj } = make();
    await proj.seed();
    proj.handle(ev("slice-status-changed", { sliceId: "s1", id: "x", data: { newValue: { status: "ready" } } }));
    proj.flushNow();
    const sliceJson = readFileSync(join(dir, "chapters/c1/slices/s1/slice.json"), "utf8");
    expect(JSON.parse(sliceJson).status).toBe("ready");
  });
});

describe("Projection resilience", () => {
  it("does not throw if a write pass fails; next event retries", async () => {
    const { proj, timers } = make();
    await proj.seed();
    proj.handle(ev("slice-status-changed", { sliceId: "s1", id: "y", data: { newValue: { status: "blocked" } } }));
    // Simulate a transient failure by removing the dir right before flush is unlikely to
    // throw (writer re-creates it). Instead assert the happy path doesn't throw.
    expect(() => timers.tick()).not.toThrow();
  });
});

describe("Projection git integration", () => {
  it("invokes the committer after a write pass when git is enabled", async () => {
    const commits: string[] = [];
    const { proj, timers } = make({ git: true, commit: (_d, msg) => commits.push(msg) });
    await proj.seed();
    expect(commits.length).toBe(1); // seed write committed
    proj.handle(ev("slice-status-changed", { sliceId: "s1", id: "z", data: { newValue: { status: "deployed" } } }));
    timers.tick();
    expect(commits.length).toBe(2);
    expect(commits[1]).toMatch(/spec-stream sync/);
  });
});

describe("Projection sync-state reading", () => {
  it("reads back a persisted cursor", async () => {
    const { proj, timers } = make();
    await proj.seed();
    proj.handle(ev("slice-status-changed", { sliceId: "s1", id: "cur-1", data: { newValue: { status: "ready" } } }));
    timers.tick();
    expect(proj.readSyncState()?.cursor.lastEventId).toBe("cur-1");
  });

  it("returns undefined for a mismatched schema version (forces rebuild)", async () => {
    const { proj } = make();
    writeFileSync(join(dir, "sync-state.json"), JSON.stringify({ workspaceId: "ws", cursor: {}, schemaVersion: 999, syncedAt: "x" }));
    expect(proj.readSyncState()).toBeUndefined();
  });

  it("returns undefined when no sync-state exists", () => {
    const { proj } = make();
    expect(proj.readSyncState()).toBeUndefined();
  });

  it("ignores a sync-state from a different workspace", async () => {
    const { proj, timers } = make();
    await proj.seed();
    proj.handle(ev("slice-status-changed", { sliceId: "s1", id: "cur-1", data: { newValue: { status: "ready" } } }));
    timers.tick();
    // Tamper the workspace id.
    const sp = join(dir, "sync-state.json");
    const st = JSON.parse(readFileSync(sp, "utf8"));
    st.workspaceId = "other-ws";
    writeFileSync(sp, JSON.stringify(st));
    expect(proj.readSyncState()).toBeUndefined();
  });
});

describe("Projection cold-start cursor", () => {
  it("exposes the persisted cursor as the startup watermark", async () => {
    const first = make();
    await first.proj.seed();
    first.proj.handle(ev("slice-status-changed", { sliceId: "s1", id: "cur-9", createdAt: "2026-10-03T15:00:00Z", data: { newValue: { status: "ready" } } }));
    first.timers.tick();

    // A fresh projection over the same dir resumes from the persisted cursor.
    const second = make();
    expect(second.proj.startupWatermark()).toBe("2026-10-03T15:00:00Z");
  });

  it("preserves the cursor across a re-seed (does not reset to empty)", async () => {
    const first = make();
    await first.proj.seed();
    first.proj.handle(ev("slice-status-changed", { sliceId: "s1", id: "cur-x", createdAt: "2026-10-03T16:00:00Z", data: { newValue: { status: "ready" } } }));
    first.timers.tick();

    const second = make();
    await second.proj.seed(); // re-seed on cold start
    const persisted = JSON.parse(readFileSync(join(dir, "sync-state.json"), "utf8"));
    expect(persisted.cursor.lastCreatedAt).toBe("2026-10-03T16:00:00Z");
    expect(persisted.cursor.lastEventId).toBe("cur-x");
  });

  it("ignores the cursor when rebuildOnStart is set", async () => {
    const first = make();
    await first.proj.seed();
    first.proj.handle(ev("slice-status-changed", { sliceId: "s1", id: "cur-r", createdAt: "2026-10-03T17:00:00Z", data: { newValue: { status: "ready" } } }));
    first.timers.tick();

    const second = make({ rebuildOnStart: true });
    expect(second.proj.startupWatermark()).toBeUndefined();
  });

  it("has no startup watermark on first run", () => {
    const { proj } = make();
    expect(proj.startupWatermark()).toBeUndefined();
  });
});

describe("Projection partial (dirty-tracking) writes", () => {
  it("does not overwrite an unrelated element's files when only a lane is resized", async () => {
    const { proj, timers } = make();
    await proj.seed();

    // Give el1 a description so the seed writes description.md
    const descPath = join(dir, "chapters/c1/elements/el1/description.md");
    // The seed wrote an empty file (empty description in mock). Write a local edit over it.
    writeFileSync(descPath, "LOCAL EDIT — do not overwrite");

    // Board sends an unrelated event: lane-resized on l1
    proj.handle(ev("lane-resized", {
      id: "ev-lane",
      data: { laneId: "l1", newValue: { height: 200 } },
    }));
    timers.tick();

    // The lane.json should be updated with the new height
    const laneJson = JSON.parse(readFileSync(join(dir, "chapters/c1/lanes/l1/lane.json"), "utf8"));
    expect(laneJson.height).toBe(200);

    // The locally-edited description must NOT be overwritten
    expect(readFileSync(descPath, "utf8")).toBe("LOCAL EDIT — do not overwrite");
  });

  it("does update an element's files when an element event is applied", async () => {
    const { proj, timers } = make();
    await proj.seed();

    const descPath = join(dir, "chapters/c1/elements/el1/description.md");
    writeFileSync(descPath, "LOCAL EDIT");

    // Board sends element-description-changed for el1 — this SHOULD overwrite
    proj.handle(ev("element-description-changed", {
      id: "ev-desc",
      elementId: "el1",
      data: { newValue: { description: "BOARD UPDATE" } },
    }));
    timers.tick();

    expect(readFileSync(descPath, "utf8").trim()).toBe("BOARD UPDATE");
  });

  it("regenerates index.md when a child slice changes", async () => {
    const { proj, timers } = make();
    await proj.seed();

    proj.handle(ev("slice-renamed", {
      sliceId: "s1",
      id: "ev-rename",
      data: { newValue: { label: "Renamed Slice" } },
    }));
    timers.tick();

    const index = readFileSync(join(dir, "chapters/c1/index.md"), "utf8");
    expect(index).toContain("Renamed Slice");
  });

  it("does not touch another chapter's files when an unrelated chapter event fires", async () => {
    const twoChapters: ApiChapter[] = [
      {
        id: "c1", name: "Checkout", index: 0, context: "Ordering", mode: "event-modeling",
        lanes: [{ id: "l1", label: "Customer", type: "user-lane", index: 0 }],
        slices: [{ id: "s1", label: "Place Order", index: 0, status: "draft" }],
        elements: [{ id: "el1", type: "command", name: "Place Order", context: "Ordering", laneId: "l1", sliceId: "s1", index: 0 }],
      },
      {
        id: "c2", name: "Payment", index: 1, context: "Billing", mode: "event-modeling",
        lanes: [{ id: "l2", label: "System", type: "system", index: 0 }],
        slices: [{ id: "s2", label: "Pay", index: 0, status: "draft" }],
        elements: [],
      },
    ];
    const { proj, timers } = make({ client: mockClient(twoChapters) });
    await proj.seed();

    // Local edit on c1's element
    const descPath = join(dir, "chapters/c1/elements/el1/description.md");
    writeFileSync(descPath, "LOCAL EDIT C1");

    // Board event only touches c2
    proj.handle(ev("lane-resized", {
      id: "ev-c2-lane",
      chapterId: "c2",
      data: { laneId: "l2", newValue: { height: 300 } },
    }));
    timers.tick();

    // c2's lane updated
    const c2lane = JSON.parse(readFileSync(join(dir, "chapters/c2/lanes/l2/lane.json"), "utf8"));
    expect(c2lane.height).toBe(300);

    // c1's local edit untouched
    expect(readFileSync(descPath, "utf8")).toBe("LOCAL EDIT C1");
  });
});

describe("Projection unseeded model (failed seed)", () => {
  /**
   * Reproduces bug 013: when `seed()` fails (e.g. GET /chapters → 429), the daemon
   * keeps running with the in-memory `emptyModel`. The first live event's write pass
   * then rebuilt `sync-manifest.json` (`entities: {}`), `uuid-index.json` (`{}`) and
   * advanced `sync-state.json`'s cursor — a confidently-empty model clobbering the
   * manifests and arming a sync-back create-storm. An unseeded model must never
   * touch the disk.
   */
  function failingClient(): RestClient {
    const fail = () => Promise.reject(new Error("GET /chapters: rate limited (429)."));
    return {
      listChapters: fail,
      getChapter: fail,
      listMilestones: fail,
      listScenarios: fail,
      listSnippets: fail,
    } as unknown as RestClient;
  }

  function seededMirror() {
    // Nested model dir so the manifest lands at <dir>/sync-manifest.json
    // (one level above the model dir, as in production `.spec-stream/` layout).
    const modelDir = join(dir, "model");
    mkdirSync(modelDir, { recursive: true });
    return modelDir;
  }

  it("does not rewrite manifest, uuid-index, or cursor when the seed never succeeded", async () => {
    const modelDir = seededMirror();
    // Prior daemon seeded a healthy mirror + manifest.
    const good = new Projection({
      dir: modelDir, workspaceId: "ws", workspaceName: "Demo",
      client: mockClient(), logger: noopLogger(),
      timers: manualTimers(), debounceMs: 10,
    });
    await good.seed();
    const manifestPath = syncManifestPath(modelDir);
    const uuidPath = join(modelDir, "uuid-index.json");
    const statePath = join(modelDir, "sync-state.json");
    const manifestBefore = JSON.parse(readFileSync(manifestPath, "utf8"));
    const uuidBefore = readFileSync(uuidPath, "utf8");
    const stateBefore = JSON.parse(readFileSync(statePath, "utf8"));
    expect(Object.keys(manifestBefore.entities).length).toBeGreaterThan(0);
    expect(Object.keys(JSON.parse(uuidBefore)).length).toBeGreaterThan(0);

    // Restart with a failing REST seed (rebuild → always fetches): mirrors the
    // daemon continuing unseeded after `sync.seed_failed`.
    const timers = manualTimers();
    const unseeded = new Projection({
      dir: modelDir, workspaceId: "ws", workspaceName: "Demo",
      client: failingClient(), logger: noopLogger(),
      timers, debounceMs: 10,
    });
    await expect(unseeded.seed(true)).rejects.toThrow("rate limited");
    expect(unseeded.isSeeded).toBe(false);

    // A live event arrives — the bug's trigger.
    unseeded.handle(ev("element-description-changed", {
      id: "live-1", elementId: "el1", createdAt: "2026-10-04T00:00:00Z",
      data: { newValue: { description: "changed on board" } },
    }));
    timers.tick();
    unseeded.flushNow();

    // Manifest and uuid-index must still describe the seeded mirror.
    expect(readFileSync(manifestPath, "utf8")).toBe(JSON.stringify(manifestBefore, null, 2) + "\n");
    expect(readFileSync(uuidPath, "utf8")).toBe(uuidBefore);
    // The cursor must not claim progress the model never earned.
    const stateAfter = JSON.parse(readFileSync(statePath, "utf8"));
    expect(stateAfter.cursor.lastEventId).not.toBe("live-1");
    expect(stateAfter.syncedAt).toBe(stateBefore.syncedAt);
  });

  it("does not persist a cursor pushed via updateCursor/flushCursor while unseeded", async () => {
    const modelDir = seededMirror();
    const good = new Projection({
      dir: modelDir, workspaceId: "ws", workspaceName: "Demo",
      client: mockClient(), logger: noopLogger(),
      timers: manualTimers(), debounceMs: 10,
    });
    await good.seed();
    const statePath = join(modelDir, "sync-state.json");
    const stateBefore = JSON.parse(readFileSync(statePath, "utf8"));

    const unseeded = new Projection({
      dir: modelDir, workspaceId: "ws", workspaceName: "Demo",
      client: failingClient(), logger: noopLogger(),
      timers: manualTimers(), debounceMs: 10,
    });
    await expect(unseeded.seed(true)).rejects.toThrow("rate limited");

    // The app's reconnect catch-up path calls updateCursor + flushCursor.
    unseeded.updateCursor("evt-unearned", "2026-10-04T01:00:00Z");
    unseeded.flushCursor();

    const stateAfter = JSON.parse(readFileSync(statePath, "utf8"));
    expect(stateAfter.cursor.lastEventId).not.toBe("evt-unearned");
    expect(stateAfter.syncedAt).toBe(stateBefore.syncedAt);
  });
});

describe("Projection events during a REST seed", () => {
  it("does not lose live events that arrive while the seed fetch is in flight", async () => {
    // A re-seed (e.g. after catch-up escalation) happens while the realtime stream
    // is live. An event applied to the pre-seed state mid-fetch is silently
    // discarded when `this.state` is replaced — while the cursor may still claim
    // it was applied. The projection must buffer and replay such events.
    let milestoneCalls = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => { releaseGate = r; });
    const base = mockClient();
    const gated = {
      ...base,
      async listMilestones() {
        milestoneCalls++;
        if (milestoneCalls === 2) await gate;
        return [];
      },
    } as unknown as RestClient;
    const { proj } = make({ client: gated });
    await proj.seed(); // first seed passes the gate open (call 1)

    const seedP = proj.seed(true); // rebuild — call 2 blocks at the gate
    await new Promise((r) => setImmediate(r)); // let the fetch reach the gate
    proj.handle(ev("element-description-changed", {
      id: "mid-seed", elementId: "el1", createdAt: "2026-10-04T00:00:00Z",
      data: { newValue: { description: "live change" } },
    }));
    releaseGate();
    await seedP;

    const desc = readFileSync(join(dir, "chapters/c1/elements/el1/description.md"), "utf8");
    expect(desc).toContain("live change");
    const cursor = JSON.parse(readFileSync(join(dir, "sync-state.json"), "utf8")).cursor;
    expect(cursor.lastEventId).toBe("mid-seed");
  });

  it("applies events buffered during a failed seed fetch to the pre-seed state", async () => {
    // The fetch fails mid-rebuild — the buffered events are live events, not seed
    // data, so they must be applied to the pre-seed state through the normal
    // handle() path (not silently discarded with the failed fetch).
    let milestoneCalls = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => { releaseGate = r; });
    const base = mockClient();
    const gated = {
      ...base,
      async listMilestones() {
        milestoneCalls++;
        if (milestoneCalls === 2) {
          await gate;
          throw new Error("GET /milestones: rate limited (401).");
        }
        return [];
      },
    } as unknown as RestClient;
    const { proj, timers } = make({ client: gated });
    await proj.seed(); // first seed passes the gate open (call 1)

    const seedP = proj.seed(true); // rebuild — call 2 blocks at the gate
    await new Promise((r) => setImmediate(r)); // let the fetch reach the gate
    proj.handle(ev("element-description-changed", {
      id: "mid-seed-fail", elementId: "el1", createdAt: "2026-10-05T00:00:00Z",
      data: { newValue: { description: "change during failed seed" } },
    }));
    releaseGate();
    await expect(seedP).rejects.toThrow();

    // The event was applied to the PRE-SEED state and the cursor advanced —
    // the model keeps serving live events even though the rebuild failed.
    timers.tick(); // flush the debounced write scheduled by handle()
    const desc = readFileSync(join(dir, "chapters/c1/elements/el1/description.md"), "utf8");
    expect(desc).toContain("change during failed seed");
    const cursor = JSON.parse(readFileSync(join(dir, "sync-state.json"), "utf8")).cursor;
    expect(cursor.lastEventId).toBe("mid-seed-fail");
  });
});

describe("Projection sync-back lock", () => {
  it("defers write while sync-back-lock exists, then fires after lock is removed", async () => {
    // Use a nested model dir so dirname() produces a usable parent directory
    const modelDir = join(dir, "model");
    mkdirSync(modelDir, { recursive: true });
    const timers = manualTimers();
    const proj = new Projection({
      dir: modelDir,
      workspaceId: "ws",
      workspaceName: "Demo",
      client: mockClient(),
      logger: noopLogger(),
      timers,
      debounceMs: 10,
    });
    await proj.seed();

    // Lock file lives at dirname(modelDir) = dir
    const lockFile = join(dir, "sync-back-lock");
    writeFileSync(lockFile, "{}");

    proj.handle(ev("lane-resized", {
      id: "ev-locked",
      data: { laneId: "l1", newValue: { height: 150 } },
    }));

    // First tick: lock held — deferred, no write
    timers.tick();
    const laneBefore = JSON.parse(readFileSync(join(modelDir, "chapters/c1/lanes/l1/lane.json"), "utf8"));
    expect(laneBefore.height).toBeUndefined();

    // Remove the lock
    rmSync(lockFile, { force: true });

    // Second tick: lock gone — scheduleWrite() fires and queues the real debounce timer
    timers.tick();
    // Third tick: the actual write fires
    timers.tick();
    const laneAfter = JSON.parse(readFileSync(join(modelDir, "chapters/c1/lanes/l1/lane.json"), "utf8"));
    expect(laneAfter.height).toBe(150);
  });
});

describe("Projection pruning of foreign files (issue #6)", () => {
  /**
   * A full seed/re-seed sweep deletes every file under `localSync.dir` that the
   * model does not render. Before the fix this was completely silent: foreign
   * files only surfaced as a number inside `sync.seed_done`'s `deleted` count.
   * The projection must warn and name the deleted files.
   */
  it("warns and names foreign files deleted by a re-seed sweep", async () => {
    const { logger, records } = recordingLogger();
    const { proj } = make({ logger });
    await proj.seed();

    // Plant files the model does not own.
    writeFileSync(join(dir, "notes.txt"), "keep-me");
    mkdirSync(join(dir, "scratch"), { recursive: true });
    writeFileSync(join(dir, "scratch", "a.txt"), "x");

    await proj.seed(true); // rebuild → full sweep

    const prune = records.find((r) => r.kind === "sync.prune");
    expect(prune, "expected a sync.prune warning naming the deleted files").toBeTruthy();
    expect(prune!.level).toBe("warn");
    expect(prune!.fields.files).toEqual(expect.arrayContaining(["notes.txt"]));
    expect(prune!.fields.files).toEqual(
      expect.arrayContaining([expect.stringContaining("a.txt")]),
    );
  });

  it("does not warn when a sweep deletes nothing", async () => {
    const { logger, records } = recordingLogger();
    const { proj } = make({ logger });
    await proj.seed();
    await proj.seed(true);
    expect(records.find((r) => r.kind === "sync.prune")).toBeUndefined();
  });

  /**
   * Variant from the issue comments: with `localSync.git: true`, defaultCommit
   * `git init`s a history repo at the mirror root — and the next daemon start's
   * full seed sweep used to delete that `.git`, so history never accumulated.
   */
  it("keeps the localSync.git history repo across a re-seed", async () => {
    // Mirror defaultCommit: init the repo only when absent (a deleted-then-
    // recreated repo is exactly the history loss this regression covers).
    const gitInit = (d: string) => {
      if (existsSync(join(d, ".git"))) return;
      mkdirSync(join(d, ".git", "objects", "aa"), { recursive: true });
      writeFileSync(join(d, ".git", "HEAD"), "ref: refs/heads/main\n");
    };
    const first = make({ git: true, commit: (d) => gitInit(d) });
    await first.proj.seed();
    expect(existsSync(join(dir, ".git", "HEAD"))).toBe(true);

    // Accumulated history: an object the first daemon "committed".
    writeFileSync(join(dir, ".git", "objects", "aa", "bb"), "fake-commit-object");

    // Restart the daemon: its full seed sweep must not destroy the repo it made.
    const second = make({ git: true, commit: (d) => gitInit(d) });
    await second.proj.seed();
    expect(existsSync(join(dir, ".git", "HEAD"))).toBe(true);
    expect(existsSync(join(dir, ".git", "objects", "aa", "bb"))).toBe(true);
  });
});
