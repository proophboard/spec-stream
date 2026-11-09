/**
 * Load a {@link ModelState} from the local file tree.
 *
 * This is the inverse of {@link render}: it reads all the .json files from disk
 * and reconstructs the in-memory model state. This is used to avoid a full REST
 * fetch on restart when the local model is already up-to-date.
 *
 * The loader reads:
 * - workspace.json for workspaceId and workspaceName
 * - chapters/[uuid]/chapter.json for chapters
 * - chapters/[uuid]/slices/[uuid]/slice.json for slices
 * - chapters/[uuid]/lanes/[uuid]/lane.json for lanes
 * - chapters/[uuid]/elements/[uuid]/element.json for elements
 * - milestones/[uuid]/milestone.json for milestones
 * - sync-state.json for the sync cursor
 *
 * The loader uses {@link applyEvent} with synthetic events to populate the model,
 * similar to {@link seedModel}. This ensures the loaded model is consistent with
 * the model built by replaying changelog events.
 */

import {
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import type { ModelState } from "./model.js";
import { applyEvent } from "./reducer.js";
import { emptyModel } from "./model.js";
import type { ChangelogEvent } from "../realtime/events.js";

function synthEvent(
  type: string,
  chapterId: string | null,
  data: Record<string, unknown>,
  extra: Partial<ChangelogEvent> = {},
): ChangelogEvent {
  return {
    id: `load-${type}-${Math.random().toString(36).slice(2)}`,
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

/** Load a ModelState from the local file tree. Returns undefined if tree is incomplete. */
export function loadFromDisk(dir: string, workspaceId: string, workspaceName: string): ModelState | undefined {
  const state = emptyModel(workspaceId, workspaceName);

  // Load workspace.json
  const workspacePath = join(dir, "workspace.json");
  if (!existsSync(workspacePath)) return undefined;
  try {
    const workspace = JSON.parse(readFileSync(workspacePath, "utf8")) as { id: string; name: string };
    // workspaceId is already set from constructor, verify it matches
    if (workspace.id !== workspaceId) return undefined;
    // Use the name from disk (not the constructor parameter) for consistency
    state.workspaceName = workspace.name;
  } catch {
    return undefined;
  }

  // Load chapters
  const chaptersDir = join(dir, "chapters");
  if (existsSync(chaptersDir)) {
    try {
      const chapterDirs = readdirSync(chaptersDir, { withFileTypes: true }).filter((d) =>
        d.isDirectory(),
      );
      for (const chapterDir of chapterDirs) {
        const chapterPath = join(chaptersDir, chapterDir.name, "chapter.json");
        if (!existsSync(chapterPath)) continue;
        let chapter: any;
        try {
          chapter = JSON.parse(readFileSync(chapterPath, "utf8")) as {
            id: string;
            name: string;
            context: string;
            index: number;
            mode: string;
            sliceOrder: string[];
            laneOrder: string[];
          };
        } catch (err) {
          // Skip malformed chapter
          continue;
        }
        applyEvent(
          state,
          synthEvent("chapter-added", null, {
            newValue: {
              id: chapter.id,
              name: chapter.name,
              context: chapter.context,
              index: chapter.index,
              mode: chapter.mode,
              sliceOrder: chapter.sliceOrder,
              laneOrder: chapter.laneOrder,
            },
          }),
        );

        // Load slices in the order specified by chapter.sliceOrder (not filesystem order)
        const slicesDir = join(chaptersDir, chapterDir.name, "slices");
        if (existsSync(slicesDir) && Array.isArray(chapter.sliceOrder)) {
          // Load slices in the order from chapter.json's sliceOrder
          for (const sliceId of chapter.sliceOrder) {
            const sliceDir = join(slicesDir, sliceId);
            if (!existsSync(sliceDir)) continue;
            const slicePath = join(sliceDir, "slice.json");
            if (!existsSync(slicePath)) continue;
            try {
              const slice = JSON.parse(readFileSync(slicePath, "utf8")) as {
                id: string;
                label: string;
                chapterId: string;
                index: number;
                status?: string;
                width?: number;
                icon?: string;
                milestoneId?: string;
                milestoneName?: string;
                assignee?: string;
                estimate?: string;
                timeSpent?: string;
              };
              // Read details.md
              const detailsPath = join(slicesDir, sliceId, "details.md");
              const details = existsSync(detailsPath) ? readFileSync(detailsPath, "utf8").trim() : "";
              
              // Load comments from comments/ subdirectory
              const commentsPath = join(slicesDir, sliceId, "comments");
              const comments: { id: string; text: string; author?: string; userId?: string; createdAt?: string; isTask?: boolean }[] = [];
              if (existsSync(commentsPath)) {
                const commentDirs = readdirSync(commentsPath, { withFileTypes: true }).filter((d) =>
                  d.isDirectory(),
                );
                for (const commentDir of commentDirs) {
                  const commentJsonPath = join(commentsPath, commentDir.name, "comment.json");
                  if (existsSync(commentJsonPath)) {
                    const comment = JSON.parse(readFileSync(commentJsonPath, "utf8")) as {
                      id: string;
                      text: string;
                      author?: string;
                      userId?: string;
                      createdAt?: string;
                      isTask?: boolean;
                    };
                    // comment.json holds metadata only; the text body lives in comment.md.
                    const commentMdPath = join(commentsPath, commentDir.name, "comment.md");
                    const text = existsSync(commentMdPath)
                      ? readFileSync(commentMdPath, "utf8").trim()
                      : (comment.text ?? "");
                    comments.push({ ...comment, text });
                  }
                }
              }
              
              applyEvent(
                state,
                synthEvent("slice-added", chapterDir.name, {
                  newValue: { slice: {
                    id: slice.id,
                    label: slice.label,
                    chapterId: slice.chapterId,
                    index: slice.index,
                    status: slice.status,
                    width: slice.width,
                    icon: slice.icon,
                    details,
                    comments,
                    milestoneId: slice.milestoneId,
                    milestoneName: slice.milestoneName,
                    assignee: slice.assignee,
                    estimate: slice.estimate,
                    timeSpent: slice.timeSpent,
                  } },
                }),
              );
            } catch (err) {
              // Skip malformed slice
              continue;
            }
          }
        }

        // Load lanes in the order specified by chapter.laneOrder (not filesystem order)
        const lanesDir = join(chaptersDir, chapterDir.name, "lanes");
        if (existsSync(lanesDir) && Array.isArray(chapter.laneOrder)) {
          // Load lanes in the order from chapter.json's laneOrder
          for (const laneId of chapter.laneOrder) {
            const laneDir = join(lanesDir, laneId);
            if (!existsSync(laneDir)) continue;
            const lanePath = join(laneDir, "lane.json");
            if (!existsSync(lanePath)) continue;
            try {
              const lane = JSON.parse(readFileSync(lanePath, "utf8")) as {
                id: string;
                label: string;
                type: string;
                chapterId: string;
                index: number;
                height?: number;
                icon?: string;
              };
              applyEvent(state, synthEvent("lane-added", chapterDir.name, { newValue: { lane } }));
            } catch {
              // Skip malformed lane
              continue;
            }
          }
        }

        // Load elements
        const elementsDir = join(chaptersDir, chapterDir.name, "elements");
        if (existsSync(elementsDir)) {
          const elementDirs = readdirSync(elementsDir, { withFileTypes: true }).filter((d) =>
            d.isDirectory(),
          );
          for (const elementDir of elementDirs) {
            const elementPath = join(elementsDir, elementDir.name, "element.json");
            if (!existsSync(elementPath)) continue;
            try {
              const element = JSON.parse(readFileSync(elementPath, "utf8")) as {
                id: string;
                type: string;
                name: string;
                context: string;
                laneId: string;
                sliceId: string;
                chapterId: string;
                index: number;
                icon?: string;
                noArrowSource?: boolean;
                noArrowTarget?: boolean;
              };
              // Read description.md and details.md
              const descriptionPath = join(elementsDir, elementDir.name, "description.md");
              const detailsPath = join(elementsDir, elementDir.name, "details.md");
              // Read play-function.ts and play-type.ts if they exist
              const playFunctionPath = join(elementsDir, elementDir.name, "play-function.ts");
              const playTypePath = join(elementsDir, elementDir.name, "play-type.ts");
              // Read comments from comments/ subdirectory
              const commentsPath = join(elementsDir, elementDir.name, "comments");
              
              const description = existsSync(descriptionPath) ? readFileSync(descriptionPath, "utf8").trim() : "";
              const details = existsSync(detailsPath) ? readFileSync(detailsPath, "utf8").trim() : "";
              // Strip "type Payload = " prefix if present (to handle corrupted files from earlier versions)
              const playFunction = existsSync(playFunctionPath) ? readFileSync(playFunctionPath, "utf8") : undefined;
              const rawPlayType = existsSync(playTypePath) ? readFileSync(playTypePath, "utf8") : undefined;
              // Strip the prefix if present; if it's already duplicated (corruption), strip both
              let playType = rawPlayType;
              if (playType?.startsWith("type Payload = ")) {
                playType = playType.slice("type Payload = ".length);
              }
              // Strip again if there's another prefix (handles corrupted files with double prefix)
              if (playType?.startsWith("type Payload = ")) {
                playType = playType.slice("type Payload = ".length);
              }
              
              // Load comments from comment files
              const comments: { id: string; text: string; author?: string; userId?: string; createdAt?: string; isTask?: boolean }[] = [];
              if (existsSync(commentsPath)) {
                try {
                  const commentDirs = readdirSync(commentsPath, { withFileTypes: true }).filter((d) =>
                    d.isDirectory(),
                  );
                  for (const commentDir of commentDirs) {
                    const commentJsonPath = join(commentsPath, commentDir.name, "comment.json");
                    if (existsSync(commentJsonPath)) {
                      const comment = JSON.parse(readFileSync(commentJsonPath, "utf8")) as {
                        id: string;
                        text: string;
                        author?: string;
                        userId?: string;
                        createdAt?: string;
                        isTask?: boolean;
                      };
                      // comment.json holds metadata only; the text body lives in comment.md.
                      const commentMdPath = join(commentsPath, commentDir.name, "comment.md");
                      const text = existsSync(commentMdPath)
                        ? readFileSync(commentMdPath, "utf8").trim()
                        : (comment.text ?? "");
                      comments.push({ ...comment, text });
                    }
                  }
                } catch {
                  // Skip comment loading errors
                }
              }
              
              applyEvent(
                state,
                synthEvent("element-added", chapterDir.name, {
                  newValue: { element: {
                    id: element.id,
                    type: element.type,
                    name: element.name,
                    context: element.context,
                    description,
                    details,
                    laneId: element.laneId,
                    sliceId: element.sliceId,
                    chapterId: element.chapterId,
                    index: element.index,
                    icon: element.icon,
                    noArrowSource: element.noArrowSource,
                    noArrowTarget: element.noArrowTarget,
                    playFunction,
                    playType,
                    comments,
                  } },
                }),
              );
            } catch {
              // Skip malformed element
              continue;
            }
          }
        }
      }
    } catch {
      // If any error occurs, return undefined (incomplete tree)
      return undefined;
    }
  }

  // Load milestones
  const milestonesDir = join(dir, "milestones");
  if (existsSync(milestonesDir)) {
    try {
      const milestoneDirs = readdirSync(milestonesDir, { withFileTypes: true }).filter((d) =>
        d.isDirectory(),
      );
      for (const milestoneDir of milestoneDirs) {
        const milestonePath = join(milestonesDir, milestoneDir.name, "milestone.json");
        if (!existsSync(milestonePath)) continue;
        try {
          const milestone = JSON.parse(readFileSync(milestonePath, "utf8")) as {
            id: string;
            name: string;
            description: string;
            deadline?: string;
            color?: string;
            isCompleted?: boolean;
            completedAt?: string;
            createdAt?: string;
            updatedAt?: string;
            slices: { sliceId: string; label?: string; chapterId?: string; chapterName?: string; status?: string; estimate?: string; timeSpent?: string }[];
          };
          applyEvent(state, synthEvent("milestone-added", null, { newValue: { milestone } }));
        } catch {
          // Skip malformed milestone
          continue;
        }
      }
    } catch {
      // If any error occurs, return undefined (incomplete tree)
      return undefined;
    }
  }

  // Load scenarios
  const scenariosDir = join(dir, "chapters"); // Scenarios are under chapters
  if (existsSync(scenariosDir)) {
    try {
      const chapterDirs = readdirSync(scenariosDir, { withFileTypes: true }).filter((d) =>
        d.isDirectory(),
      );
      for (const chapterDir of chapterDirs) {
        const chapterScenariosDir = join(scenariosDir, chapterDir.name, "scenarios");
        if (existsSync(chapterScenariosDir)) {
          const scenarioDirs = readdirSync(chapterScenariosDir, { withFileTypes: true }).filter((d) =>
            d.isDirectory(),
          );
          for (const scenarioDir of scenarioDirs) {
            const scenarioPath = join(chapterScenariosDir, scenarioDir.name, "scenario.json");
            if (!existsSync(scenarioPath)) continue;
            try {
              const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as {
                id: string;
                chapterId: string;
                name: string;
                clock?: string;
                initialState: Record<string, unknown>;
                seededEvents: { name: string; context: string; payload: Record<string, unknown>; timestamp?: string }[];
                interactions: { uiElementId: string; storage: Record<string, unknown> }[];
                expectations: { id: string; sliceId: string; kind: "events" | "information" | "rejection"; elementId?: string; match?: "exact" | "subset"; expected: Record<string, unknown> }[];
                createdAt?: string;
                updatedAt?: string;
              };
              applyEvent(state, synthEvent("scenario-created", chapterDir.name, { newValue: { scenario } }));
            } catch {
              // Skip malformed scenario
              continue;
            }
          }
        }
      }
    } catch {
      // If any error occurs, return undefined (incomplete tree)
      return undefined;
    }
  }

  // Load HTML snippets
  const snippetsDir = join(dir, "html-snippets");
  if (existsSync(snippetsDir)) {
    try {
      const snippetFiles = readdirSync(snippetsDir, { withFileTypes: true }).filter((d) =>
        d.isFile() && d.name.endsWith(".html"),
      );
      // Read the .html file for each snippet
      for (const snippetFile of snippetFiles) {
        const htmlPath = join(snippetsDir, snippetFile.name);
        if (existsSync(htmlPath)) {
          try {
            const htmlContent = readFileSync(htmlPath, "utf8");
            // The slug is the filename without .html extension
            const slug = snippetFile.name.slice(0, -5); // remove ".html"
            const jsonPath = join(snippetsDir, slug + ".json");
            let snippetData: { slug: string; name: string; createdAt?: string; updatedAt?: string };
            if (existsSync(jsonPath)) {
              snippetData = JSON.parse(readFileSync(jsonPath, "utf8")) as { slug: string; name: string; createdAt?: string; updatedAt?: string };
            } else {
              // Fallback: derive from slug
              snippetData = { slug, name: slug };
            }
            // Build the snippet object matching the API structure (slug, name, snippet, created_at, updated_at)
            const snippetObj = {
              slug: snippetData.slug,
              name: snippetData.name,
              snippet: htmlContent,
              created_at: snippetData.createdAt,
              updated_at: snippetData.updatedAt,
            };
            applyEvent(state, synthEvent("html-snippet-added", null, {
              slug: snippetData.slug,
              newValue: { snippet: snippetObj },
            }));
          } catch {
            // Skip malformed snippet
            continue;
          }
        }
      }
    } catch {
      // If any error occurs, return undefined (incomplete tree)
      return undefined;
    }
  }

  return state;
}
