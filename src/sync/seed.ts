/**
 * Seed a {@link ModelState} from REST API responses.
 *
 * The projection seeds its initial model from the HTTP API (`GET /chapters`,
 * `GET /chapters/{id}`, `GET /milestones`) and then applies incremental changelog events.
 *
 * Rather than duplicating the reducer's normalization and shared-details wiring, seeding
 * **synthesizes `*-added` changelog events** and runs them through {@link applyEvent}. This
 * guarantees that a model seeded from REST is byte-for-byte identical to the same model
 * built by replaying the changelog from the beginning — the property that makes "rebuild
 * is always correct" hold regardless of the seeding path.
 */

import { applyEvent } from "./reducer.js";
import { emptyModel, type ModelState } from "./model.js";
import type { ChangelogEvent } from "../realtime/events.js";
import type { ApiChapter, ApiChapterSummary, ApiMilestone, ApiScenario, ApiHtmlSnippet, RestClient } from "./restClient.js";
import { RestError } from "./restClient.js";

function synthEvent(
  type: string,
  chapterId: string | null,
  data: Record<string, unknown>,
  extra: Partial<ChangelogEvent> = {},
): ChangelogEvent {
  return {
    id: `seed-${type}-${Math.random().toString(36).slice(2)}`,
    type,
    timestamp: 0,
    workspaceId: "",
    chapterId,
    chapterName: undefined,
    userId: undefined,
    addedByAgent: false,
    createdAt: "1970-01-01T00:00:00Z",
    data,
    row: {} as ChangelogEvent["row"],
    ...extra,
  };
}

/** Build a ModelState from already-fetched chapters, milestones, and scenarios. Pure, no I/O. */
export function seedModelFromData(
  workspaceId: string,
  workspaceName: string,
  chapters: ApiChapter[],
  milestones: ApiMilestone[],
  scenariosByChapter: Map<string, ApiScenario[]> = new Map(),
  htmlSnippets: ApiHtmlSnippet[] = [],
): ModelState {
  const state = emptyModel(workspaceId, workspaceName);

  // Chapters first (so slice/lane/element adds can attach), ordered by index.
  const ordered = [...chapters].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  for (const chapter of ordered) {
    applyEvent(
      state,
      synthEvent("chapter-added", chapter.id, {
        newValue: { id: chapter.id, name: chapter.name, mode: chapter.mode },
      }, { context: chapter.context }),
    );

    // Lanes (ordered) — establishes laneOrder.
    for (const lane of sortByIndex(chapter.lanes)) {
      applyEvent(state, synthEvent("lane-added", chapter.id, { newValue: { lane } }));
    }
    // Slices (ordered) — establishes sliceOrder.
    for (const slice of sortByIndex(chapter.slices)) {
      // Strip inline comments from the slice payload so they are not populated twice
      // (once inline via putSliceFromRaw, once via the explicit add loop below).
      const { comments: sliceComments, ...sliceNoComments } = slice as Record<string, unknown>;
      applyEvent(state, synthEvent("slice-added", chapter.id, { newValue: { slice: sliceNoComments } }));
      // Seed slice comments, if the API included them inline.
      const scomments = Array.isArray(sliceComments) ? (sliceComments as Record<string, unknown>[]) : [];
      for (const comment of scomments) {
        applyEvent(
          state,
          synthEvent("new-slice-comment-written", chapter.id, { newValue: { comment } }, {
            sliceId: String((slice as Record<string, unknown>).id ?? ""),
          }),
        );
      }
    }
    // Elements — each carries its own laneId/sliceId/index.
    // Elements from the REST API may also carry playFunction/playType.
    for (const element of chapter.elements) {
      // Strip inline comments from the element payload so they are not populated twice
      // (once inline via putElementFromRaw, once via the explicit add loop below).
      const { comments: elComments, ...elementNoComments } = element as Record<string, unknown>;
      applyEvent(
        state,
        synthEvent("element-added", chapter.id, { newValue: { element: elementNoComments } }),
      );
      // Seed element comments, if the API included them inline.
      const comments = Array.isArray(elComments)
        ? (elComments as Record<string, unknown>[])
        : [];
      for (const comment of comments) {
        applyEvent(
          state,
          synthEvent("element-comment-added", chapter.id, { newValue: comment }, {
            elementId: String((element as Record<string, unknown>).id ?? ""),
          }),
        );
      }
    }

    // Scenarios for this chapter.
    const scenarios = scenariosByChapter.get(chapter.id) ?? [];
    for (const scenario of scenarios) {
      applyEvent(
        state,
        synthEvent("scenario-created", chapter.id, {
          scenarioId: scenario.id,
          newValue: { scenario },
        }),
      );
    }
  }

  // Milestones last (so slice refs resolve to existing slices).
  for (const milestone of milestones) {
    applyEvent(state, synthEvent("milestone-added", null, { newValue: { milestone } }));
  }

  // HTML snippets — workspace-level, no chapter context needed.
  for (const htmlSnippet of htmlSnippets) {
    applyEvent(
      state,
      synthEvent("html-snippet-added", null, {
        slug: htmlSnippet.slug,
        newValue: { snippet: htmlSnippet },
      }),
    );
  }

  return state;
}

/**
 * Mutable checkpoint letting a failed {@link seedModel} call resume where it
 * stopped instead of re-fetching the whole snapshot. The projection keeps one
 * instance across seed retries: under the platform's intermittent 401s a seed
 * attempt may die after dozens of successful requests — without a checkpoint
 * every retry burns the same scarce quota re-downloading chapters it already
 * had. Data captured in a checkpoint is at most seconds/minutes old; changes
 * the board saw in the meantime arrive as changelog events on top.
 */
export interface SeedProgress {
  /** Chapter summaries as returned by the first listChapters() call. */
  summaries?: ApiChapterSummary[];
  /** Full chapters fetched so far, keyed for idempotent re-entry. */
  chaptersById: Map<string, ApiChapter>;
  /** Scenarios fetched so far, per chapter id. */
  scenariosByChapter: Map<string, ApiScenario[]>;
  /** Index into `summaries` of the first chapter not fully fetched yet. */
  nextChapterIndex: number;
  milestones?: ApiMilestone[];
  htmlSnippets?: ApiHtmlSnippet[];
}

export function freshSeedProgress(): SeedProgress {
  return { chaptersById: new Map(), scenariosByChapter: new Map(), nextChapterIndex: 0 };
}

/**
 * Retry a single REST call on transient per-request failures — spurious 401
 * blips, server errors, network drops. The platform intermittently answers
 * individual requests with bare 401s under load; retrying just the failing
 * call turns a blip that would abort the whole seed attempt into an invisible
 * hiccup. The next attempt is paced by the shared limiter, which the rejection
 * has already slowed.
 *
 * Signalled throttling (429, quota-flavoured 401) is NOT retried here — the
 * seed-level retry honours the Retry-After window, and hammering a real quota
 * wall would only burn budget. Non-retryable errors propagate immediately.
 */
const TRANSIENT_ATTEMPTS = 3;
async function withTransientRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < TRANSIENT_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (
        !(err instanceof RestError) ||
        !err.retryable ||
        (err.kind === "rate_limited" && !err.transient)
      ) {
        throw err;
      }
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Fetch chapters (full), milestones, and scenarios from the API, then seed the model. */
export async function seedModel(
  client: RestClient,
  workspaceId: string,
  workspaceName: string,
  progress?: SeedProgress,
): Promise<ModelState> {
  const p = progress ?? freshSeedProgress();
  p.summaries ??= await withTransientRetry(() => client.listChapters());
  // Sequential on purpose: the shared rate limiter serializes requests anyway, so
  // a parallel burst gains nothing — and when a request fails, the burst's queued
  // leftovers would keep draining the limiter (and the API quota) while the
  // scheduled retry is still waiting out its backoff.
  // With a `progress` checkpoint the loop continues at the chapter that failed
  // instead of restarting from the top of the list.
  for (let i = p.nextChapterIndex; i < p.summaries.length; i++) {
    const summary = p.summaries[i];
    if (!p.chaptersById.has(summary.id)) {
      p.chaptersById.set(summary.id, await withTransientRetry(() => client.getChapter(summary.id)));
    }
    const scenarios = await withTransientRetry(() => client.listScenarios(summary.id));
    if (scenarios.length > 0) p.scenariosByChapter.set(summary.id, scenarios);
    p.nextChapterIndex = i + 1;
  }
  p.milestones ??= await withTransientRetry(() => client.listMilestones());
  p.htmlSnippets ??= await withTransientRetry(() => client.listSnippets());

  const chapters = p.summaries
    .map((summary) => p.chaptersById.get(summary.id))
    .filter((chapter): chapter is ApiChapter => chapter !== undefined);

  return seedModelFromData(workspaceId, workspaceName, chapters, p.milestones, p.scenariosByChapter, p.htmlSnippets);
}

function sortByIndex(arr: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...arr].sort((a, b) => (num(a.index) ?? 0) - (num(b.index) ?? 0));
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
