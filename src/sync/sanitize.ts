/**
 * Path-segment sanitizer for the local model projection.
 *
 * The on-disk file tree uses human/agent-readable directory names derived from prooph
 * board names and labels. Those values are **untrusted** (anyone who can edit the board
 * produces them) and are not guaranteed to be filesystem-safe. This module is the single
 * place that converts a raw name into a safe path segment.
 *
 * Rules (see docs/local-sync.md):
 * - Replace path separators and reserved characters (`/ \ : * ? " < > |`), control
 *   chars, and other unsafe bytes with `-`.
 * - Collapse whitespace and repeated separators to a single `-`.
 * - Trim leading/trailing dots, spaces, and `-` (Windows dislikes trailing dots/spaces).
 * - Enforce a max length.
 * - Never emit `.` or `..`.
 * - If the result is empty, fall back to the provided `fallback` (usually the entity id).
 *
 * The raw value is always preserved verbatim in the entity's `.json`; the sanitized form
 * is only ever used for directory/file names.
 */

/** Max length of a single path segment (bytes/chars). Keeps paths well under OS limits. */
export const MAX_SEGMENT_LENGTH = 80;

// Characters that are unsafe on common filesystems (Windows is the strictest).
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;
const WHITESPACE_RUNS = /\s+/g;
const SEPARATOR_RUNS = /-+/g;
const EDGE_TRIM = /^[-.\s]+|[-.\s]+$/g;

/**
 * Convert a raw name/label into a safe path segment.
 *
 * @param raw The raw name or label from the model.
 * @param fallback Used when sanitization yields an empty string (e.g. the entity id).
 * @returns A filesystem-safe segment, never empty, never `.`/`..`.
 */
export function sanitizeSegment(raw: string, fallback: string): string {
  const safeFallback = rawFallback(fallback);

  if (typeof raw !== "string") return safeFallback;

  let s = raw.normalize("NFC");
  s = s.replace(UNSAFE_CHARS, "-");
  s = s.replace(WHITESPACE_RUNS, "-");
  s = s.replace(SEPARATOR_RUNS, "-");
  s = s.replace(EDGE_TRIM, "");

  if (s.length > MAX_SEGMENT_LENGTH) {
    s = s.slice(0, MAX_SEGMENT_LENGTH).replace(EDGE_TRIM, "");
  }

  // Reserved relative-path names, or anything that collapsed to empty.
  if (s.length === 0 || s === "." || s === "..") {
    return safeFallback;
  }

  return s;
}

/**
 * Build a slug-only directory segment from a name. The entity id is **not** included in
 * the path — it lives in the `.json` file and in `uuid-index.json` at the model root.
 * Falls back to the sanitized id when the name is empty or produces an unusable slug.
 */
export function nameSlug(id: string, name: string): string {
  const safeId = rawFallback(id);
  return sanitizeSegment(name, safeId);
}

/**
 * Build an `[index]_[name]` segment used where on-disk ordering should reflect model
 * order (slices, elements). The zero-padded index sorts lexicographically.
 * The entity id is not embedded in the path; use `nameSlug` directly for non-ordered
 * entities (chapters, lanes, milestones, scenarios).
 */
export function orderedSegment(index: number, id: string, name: string): string {
  const idx = Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0;
  const padded = String(idx).padStart(4, "0");
  return `${padded}_${nameSlug(id, name)}`;
}

/** Last-resort sanitization for the fallback itself (ids are uuid-safe, but be defensive). */
function rawFallback(fallback: string): string {
  if (typeof fallback !== "string") return "unknown";
  const s = fallback
    .normalize("NFC")
    .replace(UNSAFE_CHARS, "-")
    .replace(WHITESPACE_RUNS, "-")
    .replace(SEPARATOR_RUNS, "-")
    .replace(EDGE_TRIM, "")
    .slice(0, MAX_SEGMENT_LENGTH);
  return s.length > 0 && s !== "." && s !== ".." ? s : "unknown";
}
