/**
 * Path parser for the sync-back command.
 *
 * Takes a file path relative to the local sync root (e.g. `.spec-stream/model`) and
 * parses it into a structured {@link ParsedPath} descriptor that identifies which entity
 * the file belongs to, what file type it is, and the full directory path.
 *
 * The local model file layout is:
 *
 *   chapters/[Context]/[Chapter]/
 *     chapter.json, index.md
 *     slices/[index]_[Slice]/
 *       slice.json, details.md
 *       lanes/[laneType]/[Lane]/
 *         lane.json
 *         elements/[index]_[Element]/
 *           element.json, description.md, details.md, play-function.ts, play-type.ts
 *   element-details/[Context]/[ElementType]/[Element]/details.md
 *   milestones/[Milestone]/
 *     milestone.json, description.md
 *
 * IMPORTANT: UUIDs are NOT in paths. They live in the .json files.
 * The parser just identifies the entity type and the directory containing the .json.
 */

export type EntityKind = "chapter" | "slice" | "lane" | "element" | "milestone" | "element-details" | "html-snippet" | "scenario";

export type FileRole =
  | "chapter.json"
  | "index.md"           // generated, skip
  | "slice.json"
  | "slice.details"
  | "lane.json"
  | "element.json"
  | "element.description"
  | "element.details"
  | "element.play-function"
  | "element.play-type"
  | "element-details.details"
  | "milestone.json"
  | "milestone.description"
  | "html-snippet.html"
  | "html-snippet.json"
  | "scenario.json"
  | "unknown";

export interface ParsedPath {
  kind: EntityKind;
  /** The directory containing the entity's primary .json (relative to sync root). */
  entityDir: string;
  /** What file this path represents. */
  role: FileRole;
  /** True if this file is auto-generated and should never be synced back. */
  generated: boolean;
}

/**
 * Parse a relative file path (forward-slash, relative to the sync root) into a
 * structured descriptor.
 *
 * Returns `null` for paths that are not part of the managed model tree (uuid-index.json,
 * workspace.json, sync-state.json, comment files, scenario files, lane-details, etc.) or
 * that are not supported for sync-back.
 */
export function parseSyncPath(relPath: string): ParsedPath | null {
  // Normalize to forward-slash.
  const p = relPath.replace(/\\/g, "/");

  // ─── element-details canonical details ──────────────────────────────────────
  // element-details/[Context]/[ElementType]/[Element name]/details.md
  const edMatch = p.match(/^element-details\/[^/]+\/[^/]+\/[^/]+\/(details\.md)$/);
  if (edMatch) {
    const dir = p.slice(0, p.lastIndexOf("/"));
    return { kind: "element-details", entityDir: dir, role: "element-details.details", generated: false };
  }

  // ─── html-snippets ───────────────────────────────────────────────────────────
  // html-snippets/[slug].html  or  html-snippets/[slug].json
  const snippetMatch = p.match(/^html-snippets\/([^/]+)\.(html|json)$/);
  if (snippetMatch) {
    const [, slugSeg, ext] = snippetMatch;
    const dir = `html-snippets/${slugSeg}`;
    const role: FileRole = ext === "html" ? "html-snippet.html" : "html-snippet.json";
    return { kind: "html-snippet", entityDir: dir, role, generated: false };
  }

  // ─── chapter tree ────────────────────────────────────────────────────────────
  // chapters/[Context]/[Chapter name]/...
  const chapterBase = p.match(/^(chapters\/[^/]+\/[^/]+)(?:\/(.*))?$/);
  if (!chapterBase) {
    // not a chapter path — could be milestones, workspace.json, uuid-index.json, etc.
    return parseMilestonePath(p);
  }

  const [, chapterDir, rest] = chapterBase;

  if (!rest) return null; // just the chapter directory itself

  // chapter.json / index.md (direct chapter files)
  if (rest === "chapter.json") {
    return { kind: "chapter", entityDir: chapterDir, role: "chapter.json", generated: false };
  }
  if (rest === "index.md") {
    return { kind: "chapter", entityDir: chapterDir, role: "index.md", generated: true };
  }

  // Scenarios — scenario.json is synced back (expectations); other scenario files skipped
  if (rest.startsWith("scenarios/")) {
    const scenarioMatch = rest.match(/^(scenarios\/[^/]+)\/(scenario\.json)$/);
    if (!scenarioMatch) return null; // not scenario.json
    const [, scenarioSeg] = scenarioMatch;
    const scenarioDir = `${chapterDir}/${scenarioSeg}`;
    return { kind: "scenario", entityDir: scenarioDir, role: "scenario.json", generated: false };
  }

  // slices/[index]_[Slice label]/...
  const sliceMatch = rest.match(/^(slices\/[^/]+)(?:\/(.*))?$/);
  if (!sliceMatch) return null;

  const [, sliceSeg, sliceRest] = sliceMatch;
  const sliceDir = `${chapterDir}/${sliceSeg}`;

  if (!sliceRest) return null;

  if (sliceRest === "slice.json") {
    return { kind: "slice", entityDir: sliceDir, role: "slice.json", generated: false };
  }
  if (sliceRest === "details.md") {
    return { kind: "slice", entityDir: sliceDir, role: "slice.details", generated: false };
  }
  // comments, index.md within slice — skip
  if (sliceRest.startsWith("comments/")) return null;

  // lanes/[laneType]/[Lane label]/...
  const laneMatch = sliceRest.match(/^(lanes\/[^/]+\/[^/]+)(?:\/(.*))?$/);
  if (!laneMatch) return null;

  const [, laneSeg, laneRest] = laneMatch;
  const laneDir = `${sliceDir}/${laneSeg}`;

  if (!laneRest) return null;

  if (laneRest === "lane.json") {
    return { kind: "lane", entityDir: laneDir, role: "lane.json", generated: false };
  }

  // elements/[index]_[Element name]/...
  const elemMatch = laneRest.match(/^(elements\/[^/]+)(?:\/(.*))?$/);
  if (!elemMatch) return null;

  const [, elemSeg, elemRest] = elemMatch;
  const elemDir = `${laneDir}/${elemSeg}`;

  if (!elemRest) return null;

  switch (elemRest) {
    case "element.json":
      return { kind: "element", entityDir: elemDir, role: "element.json", generated: false };
    case "description.md":
      return { kind: "element", entityDir: elemDir, role: "element.description", generated: false };
    case "details.md":
      return { kind: "element", entityDir: elemDir, role: "element.details", generated: false };
    case "play-function.ts":
      return { kind: "element", entityDir: elemDir, role: "element.play-function", generated: false };
    case "play-type.ts":
      return { kind: "element", entityDir: elemDir, role: "element.play-type", generated: false };
    default:
      // comments or anything else under an element
      return null;
  }
}

function parseMilestonePath(p: string): ParsedPath | null {
  // milestones/[Milestone name]/...
  const mMatch = p.match(/^(milestones\/[^/]+)(?:\/(.*))?$/);
  if (!mMatch) return null;

  const [, milestoneDir, rest] = mMatch;
  if (!rest) return null;

  if (rest === "milestone.json") {
    return { kind: "milestone", entityDir: milestoneDir, role: "milestone.json", generated: false };
  }
  if (rest === "description.md") {
    return { kind: "milestone", entityDir: milestoneDir, role: "milestone.description", generated: false };
  }
  return null;
}

/**
 * Given a parsed path's entityDir, return the path to the primary .json file for
 * that entity (e.g. element.json, slice.json, etc.).
 */
export function primaryJsonPath(parsed: ParsedPath): string {
  switch (parsed.kind) {
    case "chapter":       return `${parsed.entityDir}/chapter.json`;
    case "slice":         return `${parsed.entityDir}/slice.json`;
    case "lane":          return `${parsed.entityDir}/lane.json`;
    case "element":       return `${parsed.entityDir}/element.json`;
    case "milestone":     return `${parsed.entityDir}/milestone.json`;
    case "element-details": return `${parsed.entityDir}/details.md`;
    case "html-snippet":  return `${parsed.entityDir}.json`;
    case "scenario":      return `${parsed.entityDir}/scenario.json`;
  }
}
