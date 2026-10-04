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
import type { ApiChapter, ApiMilestone, RestClient } from "./restClient.js";

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

/** Build a ModelState from already-fetched chapters and milestones. Pure, no I/O. */
export function seedModelFromData(
  workspaceId: string,
  workspaceName: string,
  chapters: ApiChapter[],
  milestones: ApiMilestone[],
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
      applyEvent(state, synthEvent("slice-added", chapter.id, { newValue: { slice } }));
    }
    // Elements — each carries its own laneId/sliceId/index.
    for (const element of chapter.elements) {
      applyEvent(
        state,
        synthEvent("element-added", chapter.id, { newValue: { element } }),
      );
      // Seed element comments, if the API included them inline.
      const comments = Array.isArray((element as Record<string, unknown>).comments)
        ? ((element as Record<string, unknown>).comments as Record<string, unknown>[])
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
  }

  // Milestones last (so slice refs resolve to existing slices).
  for (const milestone of milestones) {
    applyEvent(state, synthEvent("milestone-added", null, { newValue: { milestone } }));
  }

  return state;
}

/** Fetch chapters (full) and milestones from the API, then seed the model. */
export async function seedModel(
  client: RestClient,
  workspaceId: string,
  workspaceName: string,
): Promise<ModelState> {
  const summaries = await client.listChapters();
  const chapters: ApiChapter[] = [];
  for (const summary of summaries) {
    chapters.push(await client.getChapter(summary.id));
  }
  const milestones = await client.listMilestones();
  return seedModelFromData(workspaceId, workspaceName, chapters, milestones);
}

function sortByIndex(arr: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...arr].sort((a, b) => (num(a.index) ?? 0) - (num(b.index) ?? 0));
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
