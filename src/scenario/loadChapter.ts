/**
 * Load a Chapter from the local-sync file tree.
 *
 * The on-disk layout is slice-first (see docs/local-sync.md):
 *
 *   chapters/[Ctx]/[id]_[Name]/
 *     chapter.json
 *     slices/[index]_[id]_[Label]/
 *       slice.json
 *       lanes/[laneType]/[id]_[Lane]/
 *         lane.json
 *         elements/[index]_[id]_[Element]/
 *           element.json
 *           play-function.ts   (optional)
 *           play-type.ts       (optional — stored as "type Payload = <expr>")
 *     scenarios/[id]_[Name]/
 *       scenario.json
 *
 * uuid-index.json at the model root maps any UUID to its relative directory path.
 */

import { readFile } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import type { Chapter, Element, Lane, Slice } from "@proophboard/exploration-runtime";
import { parsePlayType } from "@proophboard/exploration-runtime";
import { globby } from "./globby.js";

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reconstruct a {@link Chapter} from the on-disk slice-first tree.
 *
 * @param chapterDir Absolute path to the chapter directory
 *   (e.g. `/path/to/.spec-stream/model/chapters/App/abc123_Todo`).
 */
export async function loadChapterFromDisk(chapterDir: string): Promise<Chapter> {
  const dir = resolve(chapterDir);

  // 1 ── chapter.json
  const chapterJson = await readJson<ChapterJson>(join(dir, "chapter.json"));

  // 2 ── slices
  const sliceJsonPaths = await globby("slices/*/slice.json", dir);
  const slices: Slice[] = await Promise.all(
    sliceJsonPaths.map(async (p) => {
      const s = await readJson<SliceJson>(p);
      return {
        id: s.id,
        label: s.label,
        index: s.index,
        status: s.status as Slice["status"],
        width: s.width ?? 200,
        icon: s.icon,
      } satisfies Slice;
    }),
  );
  slices.sort((a, b) => a.index - b.index);

  // 3 ── lanes (de-duplicated by id — each lane appears once per slice on disk)
  const laneJsonPaths = await globby("slices/*/lanes/*/*/lane.json", dir);
  const laneMap = new Map<string, Lane>();
  for (const p of laneJsonPaths) {
    const l = await readJson<LaneJson>(p);
    if (!laneMap.has(l.id)) {
      laneMap.set(l.id, {
        id: l.id,
        label: l.label,
        type: l.type as Lane["type"],
        index: l.index ?? 0,
        height: l.height ?? 150,
        icon: l.icon,
      });
    }
  }
  const lanes: Lane[] = [...laneMap.values()].sort((a, b) => a.index - b.index);

  // 4 ── elements (one per element.json)
  const elementJsonPaths = await globby(
    "slices/*/lanes/*/*/elements/*/element.json",
    dir,
  );
  const elements: Element[] = await Promise.all(
    elementJsonPaths.map((p) => loadElement(p)),
  );
  elements.sort((a, b) => a.index - b.index);

  return {
    id: chapterJson.id,
    name: chapterJson.name,
    context: chapterJson.context,
    mode: chapterJson.mode as Chapter["mode"],
    index: chapterJson.index ?? 0,
    slices,
    lanes,
    elements,
  };
}

/**
 * Resolve a chapter directory from a UUID or a file-system path.
 *
 * @param modelRoot Absolute path to the model root (the directory containing
 *   `uuid-index.json` and `chapters/`).
 * @param idOrPath A chapter UUID, or an absolute / relative path to a chapter dir.
 */
export async function resolveChapterDir(
  modelRoot: string,
  idOrPath: string,
): Promise<string> {
  const root = resolve(modelRoot);

  // Always try the uuid-index first (works for any id, not just UUIDs).
  const indexPath = join(root, "uuid-index.json");
  try {
    const idx = await readJson<Record<string, string>>(indexPath);
    const rel = idx[idOrPath];
    if (rel) return resolve(root, rel);
  } catch {
    // uuid-index.json absent — fall through to path-based resolution.
  }

  // Treat as a path.
  return isAbsolute(idOrPath) ? idOrPath : resolve(process.cwd(), idOrPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

async function loadElement(elementJsonPath: string): Promise<Element> {
  const el = await readJson<ElementJson>(elementJsonPath);
  const dir = elementJsonPath.slice(0, -"element.json".length);

  let playFunction: string | undefined;
  if (el.playFunctionRef) {
    try {
      playFunction = await readFile(join(dir, "play-function.ts"), "utf8");
    } catch {
      /* absent — leave undefined */
    }
  }

  let playType: string | undefined;
  if (el.playTypeRef) {
    try {
      const raw = await readFile(join(dir, "play-type.ts"), "utf8");
      // Stored on disk as "type Payload = <expr>" — extract the bare expression.
      const parsed = parsePlayType(raw);
      playType = parsed.ok ? parsed.value : undefined;
    } catch {
      /* absent — leave undefined */
    }
  }

  return {
    id: el.id,
    type: el.type as Element["type"],
    name: el.name,
    context: el.context,
    laneId: el.laneId,
    sliceId: el.sliceId,
    index: el.index,
    icon: el.icon,
    noArrowSource: el.noArrowSource,
    noArrowTarget: el.noArrowTarget,
    playFunction,
    playType,
  };
}

async function readJson<T>(path: string): Promise<T> {
  const content = await readFile(path, "utf8");
  return JSON.parse(content) as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// On-disk JSON shapes (subset)
// ─────────────────────────────────────────────────────────────────────────────

interface ChapterJson {
  id: string;
  name: string;
  context: string;
  mode: string;
  index?: number;
  sliceOrder: string[];
  laneOrder: string[];
}

interface SliceJson {
  id: string;
  label: string;
  index: number;
  status?: string;
  width?: number;
  icon?: string;
}

interface LaneJson {
  id: string;
  label: string;
  type: string;
  index: number;
  height?: number;
  icon?: string;
}

interface ElementJson {
  id: string;
  type: string;
  name: string;
  context: string;
  laneId: string;
  sliceId: string;
  index: number;
  icon?: string;
  noArrowSource?: boolean;
  noArrowTarget?: boolean;
  playFunctionRef?: string;
  playTypeRef?: string;
}
