/**
 * Filter predicates for the `when` clause of a mapping rule.
 * All provided filters must match (logical AND).
 */

import type { ChangelogEvent } from "../realtime/events.js";
import type { WhenFilter } from "../config/schema.js";

/** Does `value` match the filter list? Missing filter = pass. Missing value = fail (unless no filter). */
function matchesList(filter: string[] | undefined, value: string | undefined): boolean {
  if (filter === undefined) return true;
  if (value === undefined) return false;
  return filter.includes(value);
}

/**
 * Resolve a dot-path (e.g. `newValue.status`, `items.0.id`) against a payload object.
 * Returns the value at the path, or undefined if any segment is missing.
 */
function resolvePath(obj: Record<string, unknown>, dotPath: string): unknown {
  let current: unknown = obj;
  for (const segment of dotPath.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(segment);
      if (!Number.isInteger(idx)) return undefined;
      current = current[idx];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined; // can't descend into a scalar
    }
  }
  return current;
}

/** Stringify a scalar for comparison; non-scalars (objects/arrays) are not matchable. */
function scalarToString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/**
 * Match a `when.data` path→allowed-values map against an event's payload. Every path must
 * resolve to a scalar whose string form is in its allowed list (AND across paths, OR
 * within each path). A missing or non-scalar value fails.
 */
function matchesData(
  dataFilter: Record<string, string[]> | undefined,
  payload: Record<string, unknown>,
): boolean {
  if (dataFilter === undefined) return true;
  for (const [dotPath, allowed] of Object.entries(dataFilter)) {
    const value = scalarToString(resolvePath(payload, dotPath));
    if (value === undefined || !allowed.includes(value)) return false;
  }
  return true;
}

/**
 * Evaluate a rule's `when` filters against an event.
 *
 * `addedByAgent` is matched only when explicitly set (no default). Preventing agents from
 * re-triggering themselves is handled by same-user-id filtering in the Router, not here.
 */
export function matchesWhen(when: WhenFilter, event: ChangelogEvent): boolean {
  if (!matchesList(when.elementType, event.elementType)) return false;
  if (!matchesList(when.context, event.context)) return false;
  if (!matchesList(when.chapterId, event.chapterId ?? undefined)) return false;
  if (!matchesList(when.chapterName, event.chapterName)) return false;
  if (!matchesData(when.data, event.data)) return false;

  if (when.addedByAgent !== undefined && event.addedByAgent !== when.addedByAgent) {
    return false;
  }

  return true;
}
