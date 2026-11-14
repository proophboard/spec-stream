import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSyncBack } from "./syncBack.js";
import { computeDiskHash } from "./manifestDiff.js";
import {
  buildManifestFromTree,
  loadManifest,
  saveManifest,
  syncBackIdsPath,
  syncManifestPath,
  type SyncManifest,
} from "./manifest.js";
import { API_KEY_ENV } from "../config/load.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a minimal project dir:
 *   <tmp>/proophboard.spec-stream.json
 *   <tmp>/.spec-stream/model/…  (the localSync dir)
 */
function makeProject(): string {
  const dir = join(
    tmpdir(),
    `spec-stream-syncback-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(dir, ".spec-stream/model"), { recursive: true });
  writeFileSync(
    join(dir, "proophboard.spec-stream.json"),
    JSON.stringify(
      {
        endpoint: "https://board.example.test/api",
        localSync: { enabled: true, dir: ".spec-stream/model" },
        rules: [],
      },
      null,
      2,
    ),
    "utf8",
  );
  return dir;
}

function writeHtmlSnippet(projectDir: string, slug: string): void {
  const snippetsDir = join(projectDir, ".spec-stream/model/html-snippets");
  mkdirSync(snippetsDir, { recursive: true });
  writeFileSync(
    join(snippetsDir, `${slug}.json`),
    JSON.stringify({ slug, name: "My Snippet" }, null, 2),
    "utf8",
  );
  writeFileSync(join(snippetsDir, `${slug}.html`), "<div>Hello</div>", "utf8");
}

const modelDir = (projectDir: string) => join(projectDir, ".spec-stream/model");
const configPath = (projectDir: string) => join(projectDir, "proophboard.spec-stream.json");

/** A fetch mock that records every request and answers 200 {} by default. */
function makeFetch(
  calls: Array<{ method: string; url: string; body?: unknown }>,
  handler?: (call: { method: string; url: string; body?: unknown }) => Response,
): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const call = {
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    if (handler) return handler(call);
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/** Write a sync-manifest.json as the sync process would after absorbing an entity. */
function writeSyncManifest(projectDir: string, entities: SyncManifest["entities"]): void {
  saveManifest(syncManifestPath(modelDir(projectDir)), {
    version: 1,
    updatedAt: new Date().toISOString(),
    entities,
  });
}

/**
 * Simulate the sync process having absorbed a snippet: write the flat snippet
 * files AND a sync-manifest entry produced by {@link buildManifestFromTree} —
 * exactly what the projection does after rendering a snippet changelog event.
 *
 * This matters for parity: sync writes the manifest hash via
 * `buildManifestFromTree` while sync-back recomputes it via `computeDiskHash`.
 * If those two implementations disagree for the flat html-snippet layout
 * (file set, ordering, whitespace), the hash never matches and every
 * `sync-back` run emits spurious updates in a synced workspace.
 */
function seedSyncedSnippet(
  projectDir: string,
  slug: string,
  json: Record<string, unknown>,
  html: string,
): void {
  const tree = new Map<string, string>([
    [`html-snippets/${slug}.json`, JSON.stringify(json, null, 2)],
    [`html-snippets/${slug}.html`, html],
  ]);
  mkdirSync(join(modelDir(projectDir), "html-snippets"), { recursive: true });
  for (const [rel, content] of tree) {
    writeFileSync(join(modelDir(projectDir), rel), content, "utf8");
  }
  writeSyncManifest(projectDir, buildManifestFromTree(tree).entities);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runSyncBack — html-snippet GC regression", () => {
  let projectDir: string;
  let savedApiKey: string | undefined;

  beforeEach(() => {
    projectDir = makeProject();
    savedApiKey = process.env[API_KEY_ENV];
    process.env[API_KEY_ENV] = "pb_test-key";
  });

  afterEach(() => {
    if (savedApiKey === undefined) delete process.env[API_KEY_ENV];
    else process.env[API_KEY_ENV] = savedApiKey;
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("records a created html-snippet in sync-back-ids and skips it on the next run", async () => {
    writeHtmlSnippet(projectDir, "my-snippet");

    // Mock the API: the first POST /snippets succeeds (returns the slug),
    // any later create for the same slug fails with 400 "already exists" —
    // the real-world symptom of the bug.
    const posts: string[] = [];
    const fetchImpl: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/snippets")) {
        posts.push(url);
        if (posts.length === 1) {
          return new Response(JSON.stringify({ slug: "my-snippet" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ error: 'A snippet with slug "my-snippet" already exists' }),
          { status: 400, headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    // ── Run 1: creates the snippet on the board ──
    const first = await runSyncBack({
      cwd: projectDir,
      configPath: configPath(projectDir),
      fetchImpl,
      omitChecks: true,
    });
    expect(first.failed).toBe(0);
    expect(first.executed).toBe(1);
    expect(posts).toHaveLength(1);

    // The freshly created snippet must stay in sync-back-ids.json so the next
    // run knows it already exists on the board. Bug: the GC removes the entry
    // in the same run because it checks for an entity *directory* that never
    // exists for html-snippets (flat files: html-snippets/<slug>.json/.html).
    const ids = loadManifest(syncBackIdsPath(modelDir(projectDir)));
    expect(ids.entities["html-snippets/my-snippet"]).toBeDefined();
    expect(ids.entities["html-snippets/my-snippet"]?.id).toBe("my-snippet");

    // ── Run 2: nothing changed → no operations at all ──
    const second = await runSyncBack({
      cwd: projectDir,
      configPath: configPath(projectDir),
      fetchImpl,
      omitChecks: true,
    });
    // Bug: the snippet is diffed as "create" again → POST /snippets → 400.
    expect(second.operationCount).toBe(0);
    expect(second.failed).toBe(0);
    expect(posts).toHaveLength(1); // no second create call
  });

  // ─── Parallel sync: snippet already absorbed into sync-manifest ───────────

  it("recognizes a snippet hash written by sync as unchanged (hash parity)", async () => {
    // Intention: verify that a manifest hash written by the sync process
    // (buildManifestFromTree) matches the hash sync-back recomputes from disk
    // (computeDiskHash) for the flat html-snippet layout. If the two diverge,
    // every synced workspace produces spurious snippet updates on each run.
    seedSyncedSnippet(
      projectDir,
      "my-snippet",
      { slug: "my-snippet", name: "My Snippet" },
      "<div>Hello</div>",
    );

    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const result = await runSyncBack({
      cwd: projectDir,
      configPath: configPath(projectDir),
      fetchImpl: makeFetch(calls),
      omitChecks: true,
    });

    expect(result.operationCount).toBe(0);
    expect(calls).toHaveLength(0); // no API traffic at all
  });

  it("pushes a changed snippet as PATCH /snippets/<slug>, not a duplicate create", async () => {
    // Snippet known via sync-manifest (parallel sync absorbed the create),
    // then edited locally — the diff must surface as an update, not a create.
    seedSyncedSnippet(
      projectDir,
      "my-snippet",
      { slug: "my-snippet", name: "My Snippet" },
      "<div>Hello</div>",
    );
    writeFileSync(
      join(modelDir(projectDir), "html-snippets/my-snippet.html"),
      "<div>Changed</div>",
      "utf8",
    );

    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const result = await runSyncBack({
      cwd: projectDir,
      configPath: configPath(projectDir),
      fetchImpl: makeFetch(calls),
      omitChecks: true,
    });

    expect(result.failed).toBe(0);
    expect(result.executed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toContain("/snippets/my-snippet");
    expect(calls[0]!.body).toMatchObject({ snippet: "<div>Changed</div>" });
  });

  // ─── Stale sync-manifest must not re-trigger already-pushed updates ────────

  it("does not re-push an update whose sync-back-ids entry is newer than sync-manifest", async () => {
    // Reproduces the reported bug end-to-end:
    //   1. sync pulled an element → sync-manifest.json holds hash H1.
    //   2. Local rename → sync-back pushes it, writes a fresh entry (hash H2)
    //      into sync-back-ids.json.
    //   3. sync does NOT run in between (no spec-stream run pull), so
    //      sync-manifest.json still holds the stale H1 entry.
    //   Without baseHash the merge lets the stale sync-manifest entry win and
    //   every subsequent run re-emits the same rename op.
    const chapterId = "11111111-1111-4111-8111-111111111111";
    const elementId = "22222222-2222-4222-8222-222222222222";
    const elementDir = `chapters/${chapterId}/elements/${elementId}`;

    // Seed disk + sync-manifest exactly as the sync process would have written
    // them (buildManifestFromTree → hash parity with computeDiskHash).
    const chapterJson = { id: chapterId, name: "Chapter", context: "App" };
    const elementJson = { id: elementId, name: "Original Name", type: "command" };
    const tree = new Map<string, string>([
      [`chapters/${chapterId}/chapter.json`, JSON.stringify(chapterJson, null, 2)],
      [`${elementDir}/element.json`, JSON.stringify(elementJson, null, 2)],
    ]);
    for (const [rel, content] of tree) {
      const abs = join(modelDir(projectDir), rel);
      mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
      writeFileSync(abs, content, "utf8");
    }
    const seededManifest = buildManifestFromTree(tree);
    writeSyncManifest(projectDir, seededManifest.entities);
    const seededHash = seededManifest.entities[elementDir]!.hash;

    // Local rename — the only change.
    writeFileSync(
      join(modelDir(projectDir), elementDir, "element.json"),
      JSON.stringify({ ...elementJson, name: "Renamed" }, null, 2),
      "utf8",
    );

    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchImpl = makeFetch(calls);

    // ── Run 1: pushes the rename ──
    const first = await runSyncBack({
      cwd: projectDir,
      configPath: configPath(projectDir),
      fetchImpl,
      omitChecks: true,
    });
    expect(first.failed).toBe(0);
    expect(first.executed).toBe(1);
    expect(calls).toHaveLength(1);

    // The persisted entry records which sync-manifest hash it superseded.
    const ids = loadManifest(syncBackIdsPath(modelDir(projectDir)));
    const entry = ids.entities[elementDir];
    expect(entry).toBeDefined();
    expect(entry?.baseHash).toBe(seededHash);

    // ── Run 2: nothing changed, sync-manifest still stale → no ops ──
    calls.length = 0;
    const second = await runSyncBack({
      cwd: projectDir,
      configPath: configPath(projectDir),
      fetchImpl,
      omitChecks: true,
    });
    expect(second.operationCount).toBe(0);
    expect(calls).toHaveLength(0);
  });

  // ─── GC still removes genuinely stale entries ─────────────────────────────

  it("GC removes a sync-back-ids entry for an externally deleted snippet", async () => {
    // A live snippet to create (keeps the run in the persist/GC phase) …
    writeHtmlSnippet(projectDir, "live-snippet");
    // … and a stale entry for a snippet whose files were deleted externally
    // (e.g. board-side deletion processed by sync). Neither in sync-manifest
    // nor on disk → the GC must drop it.
    saveManifest(syncBackIdsPath(modelDir(projectDir)), {
      version: 1,
      updatedAt: new Date().toISOString(),
      entities: {
        "html-snippets/dead-snippet": { id: "dead-snippet", hash: "stale" },
      },
    });

    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const result = await runSyncBack({
      cwd: projectDir,
      configPath: configPath(projectDir),
      fetchImpl: makeFetch(calls, ({ method, url }) =>
        method === "POST" && url.endsWith("/snippets")
          ? new Response(JSON.stringify({ slug: "live-snippet" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : new Response(JSON.stringify({}), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
      ),
      omitChecks: true,
    });

    expect(result.failed).toBe(0);

    const ids = loadManifest(syncBackIdsPath(modelDir(projectDir)));
    expect(ids.entities["html-snippets/live-snippet"]).toBeDefined();
    expect(ids.entities["html-snippets/dead-snippet"]).toBeUndefined();
  });
});

describe("runSyncBack — board-assigned scenario ids", () => {
  let projectDir: string;
  let savedApiKey: string | undefined;

  const CHAPTER_ID = "11111111-1111-4111-8111-111111111111";
  const CHAPTER_DIR = `chapters/${CHAPTER_ID}`;

  beforeEach(() => {
    projectDir = makeProject();
    savedApiKey = process.env[API_KEY_ENV];
    process.env[API_KEY_ENV] = "pb_test-key";
  });

  afterEach(() => {
    if (savedApiKey === undefined) delete process.env[API_KEY_ENV];
    else process.env[API_KEY_ENV] = savedApiKey;
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeScenario(projectDir: string, localId: string, name = "My Scenario"): string {
    const dir = join(modelDir(projectDir), CHAPTER_DIR, "scenarios", localId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "scenario.json"),
      JSON.stringify({ id: localId, chapterId: CHAPTER_ID, name }, null, 2),
      "utf8",
    );
    return `${CHAPTER_DIR}/scenarios/${localId}`;
  }

  function writeChapter(projectDir: string): void {
    const dir = join(modelDir(projectDir), CHAPTER_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "chapter.json"),
      JSON.stringify({ id: CHAPTER_ID, name: "Chapter", context: "App" }, null, 2),
      "utf8",
    );
  }

  it("renames the local dir to the board-assigned id after a scenario create", async () => {
    // The board ignores client-supplied ids on scenario create and assigns its
    // own. Without reconciliation the local dir keeps the client UUID while the
    // next sync pull renders a second `scenarios/<board-uuid>` dir — the same
    // scenario twice on disk.
    const LOCAL_ID = "22222222-2222-4222-8222-222222222222";
    const BOARD_ID = "33333333-3333-4333-8333-333333333333";
    writeChapter(projectDir);
    const localDir = writeScenario(projectDir, LOCAL_ID);

    // The chapter is already synced — only the scenario is a create.
    writeSyncManifest(projectDir, {
      [CHAPTER_DIR]: {
        id: CHAPTER_ID,
        hash: computeDiskHash(modelDir(projectDir), CHAPTER_DIR, "chapter"),
      },
    });

    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchImpl = makeFetch(calls, ({ method, url }) =>
      method === "POST" && url.endsWith(`/chapters/${CHAPTER_ID}/scenarios`)
        ? new Response(JSON.stringify({ id: BOARD_ID }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response(JSON.stringify({}), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    );

    const first = await runSyncBack({
      cwd: projectDir,
      configPath: configPath(projectDir),
      fetchImpl,
      omitChecks: true,
    });
    expect(first.failed).toBe(0);
    expect(first.executed).toBe(1);

    // The alias dir is gone; the canonical board-id dir exists with the board id
    // inside scenario.json.
    const boardDir = `${CHAPTER_DIR}/scenarios/${BOARD_ID}`;
    expect(existsSync(join(modelDir(projectDir), localDir))).toBe(false);
    const scenarioJson = JSON.parse(
      readFileSync(join(modelDir(projectDir), boardDir, "scenario.json"), "utf8"),
    ) as { id: string };
    expect(scenarioJson.id).toBe(BOARD_ID);

    // sync-back-ids tracks the entity under its canonical dir. (The alias stub
    // under the old dir is GC'd in the same run — nothing in sync-manifest
    // references the old dir, so there is no stale entry left to guard.)
    const ids = loadManifest(syncBackIdsPath(modelDir(projectDir)));
    expect(ids.entities[boardDir]?.id).toBe(BOARD_ID);
    expect(ids.entities[localDir]).toBeUndefined();

    // Second run: the renamed dir must be recognised as already-synced — no ops.
    calls.length = 0;
    const second = await runSyncBack({
      cwd: projectDir,
      configPath: configPath(projectDir),
      fetchImpl,
      omitChecks: true,
    });
    expect(second.operationCount).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("heals a pre-existing alias dir left by an older sync-back (update path)", async () => {
    // Legacy state produced before the reconcile existed:
    //   - alias dir `scenarios/LOCAL_ID` on disk (scenario.json id = LOCAL_ID)
    //   - sync-back-ids: `scenarios/LOCAL_ID → BOARD_ID` (pushed earlier)
    //   - sync-manifest: `scenarios/LOCAL_ID → LOCAL_ID` (a sync resume rendered
    //     the alias file into the manifest)
    // Without healing, the merged diff treats the alias as an update for
    // LOCAL_ID → PATCH /scenarios/LOCAL_ID → 404 on a real board.
    const LOCAL_ID = "22222222-2222-4222-8222-222222222222";
    const BOARD_ID = "33333333-3333-4333-8333-333333333333";
    const localDir = `${CHAPTER_DIR}/scenarios/${LOCAL_ID}`;
    const boardDir = `${CHAPTER_DIR}/scenarios/${BOARD_ID}`;

    writeChapter(projectDir);
    writeScenario(projectDir, LOCAL_ID);
    writeSyncManifest(projectDir, {
      [CHAPTER_DIR]: { id: CHAPTER_ID },
      [localDir]:    { id: LOCAL_ID },
    });
    saveManifest(syncBackIdsPath(modelDir(projectDir)), {
      version: 1,
      updatedAt: new Date().toISOString(),
      entities: { [localDir]: { id: BOARD_ID } },
    });

    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const result = await runSyncBack({
      cwd: projectDir,
      configPath: configPath(projectDir),
      fetchImpl: makeFetch(calls),
      omitChecks: true,
    });
    expect(result.failed).toBe(0);

    // The alias dir must be reconciled to the board id — no op may reference
    // the client-side uuid.
    expect(existsSync(join(modelDir(projectDir), localDir))).toBe(false);
    const scenarioJson = JSON.parse(
      readFileSync(join(modelDir(projectDir), boardDir, "scenario.json"), "utf8"),
    ) as { id: string };
    expect(scenarioJson.id).toBe(BOARD_ID);
    expect(calls.every((c) => !c.url.includes(LOCAL_ID))).toBe(true);

    // The ids entry moved to the canonical dir; the stub under the old dir is
    // kept because sync-manifest still records an entry for it (it's the guard
    // that prevents a bogus DELETE for the client uuid).
    const ids = loadManifest(syncBackIdsPath(modelDir(projectDir)));
    expect(ids.entities[boardDir]?.id).toBe(BOARD_ID);
    expect(ids.entities[localDir]?.id).toBe(BOARD_ID);
  });

  it("records the board id of a create whose follow-up op hit a quota wall — next run updates instead of duplicating", async () => {
    // A run aborts on a blanket failure (quota/auth), which is correct — but the
    // create that already succeeded must not be re-issued next run. Without its
    // board-assigned id in sync-back-ids.json the next run emits another create
    // and duplicates the scenario on the board.
    const LOCAL_ID = "22222222-2222-4222-8222-222222222222";
    const BOARD_ID = "33333333-3333-4333-8333-333333333333";
    writeChapter(projectDir);
    const localDir = `${CHAPTER_DIR}/scenarios/${LOCAL_ID}`;
    const scenarioDir = join(modelDir(projectDir), localDir);
    mkdirSync(scenarioDir, { recursive: true });
    writeFileSync(
      join(scenarioDir, "scenario.json"),
      JSON.stringify(
        {
          id: LOCAL_ID,
          chapterId: CHAPTER_ID,
          name: "My Scenario",
          interactions: [{ uiElementId: "ui-1", storage: { value: "42" } }],
        },
        null,
        2,
      ),
      "utf8",
    );

    // The chapter is already synced — only the scenario is a create.
    writeSyncManifest(projectDir, {
      [CHAPTER_DIR]: {
        id: CHAPTER_ID,
        hash: computeDiskHash(modelDir(projectDir), CHAPTER_DIR, "chapter"),
      },
    });

    // First run: the create succeeds (board assigns BOARD_ID); the follow-up
    // interaction op runs into a quota-401 → the run aborts.
    let scenarioCreated = false;
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const quotaFetch = makeFetch(calls, ({ method, url }) => {
      if (method === "POST" && url.endsWith(`/chapters/${CHAPTER_ID}/scenarios`)) {
        scenarioCreated = true;
        return new Response(JSON.stringify({ id: BOARD_ID }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (scenarioCreated) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded." }), {
          status: 401,
          headers: { "content-type": "application/json", "retry-after": "30" },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const first = await runSyncBack({
      cwd: projectDir,
      configPath: configPath(projectDir),
      fetchImpl: quotaFetch,
      omitChecks: true,
    });
    expect(first.failed).toBe(1); // the interaction op failed, the run aborted

    // The create's board id is persisted as a bare entry — no hash, so the
    // entity still counts as "needs work" next run.
    const ids = loadManifest(syncBackIdsPath(modelDir(projectDir)));
    expect(ids.entities[localDir]?.id).toBe(BOARD_ID);
    expect(ids.entities[localDir]?.hash).toBeUndefined();

    // Second run, API healthy again: the entity must be pushed as an UPDATE
    // against BOARD_ID — never as a second create.
    calls.length = 0;
    const second = await runSyncBack({
      cwd: projectDir,
      configPath: configPath(projectDir),
      fetchImpl: makeFetch(calls),
      omitChecks: true,
    });
    expect(second.failed).toBe(0);
    const createCalls = calls.filter(
      (c) => c.method === "POST" && c.url.endsWith(`/chapters/${CHAPTER_ID}/scenarios`),
    );
    expect(createCalls).toHaveLength(0);
    expect(calls.some((c) => c.url.includes(BOARD_ID))).toBe(true);
  });
});
