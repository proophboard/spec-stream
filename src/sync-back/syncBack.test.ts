import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSyncBack } from "./syncBack.js";
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
