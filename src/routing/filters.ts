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
 * Evaluate a rule's `when` filters against an event.
 *
 * `addedByAgent` semantics: by default (filter undefined) agent-produced events are
 * EXCLUDED, to prevent agents re-triggering rules. Set `when.addedByAgent` explicitly
 * to opt in (true) or to require non-agent events (false).
 */
export function matchesWhen(when: WhenFilter, event: ChangelogEvent): boolean {
  if (!matchesList(when.elementType, event.elementType)) return false;
  if (!matchesList(when.context, event.context)) return false;
  if (!matchesList(when.chapterId, event.chapterId ?? undefined)) return false;
  if (!matchesList(when.chapterName, event.chapterName)) return false;

  const wantAgent = when.addedByAgent ?? false;
  if (event.addedByAgent !== wantAgent) return false;

  return true;
}
