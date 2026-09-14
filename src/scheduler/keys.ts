/**
 * Concurrency-key derivation.
 *
 * A concurrency key defines the "lane" a task runs in. Tasks sharing a key (within a
 * rule) are coordinated by the scheduler; different keys are independent.
 */

import type { ChangelogEvent } from "../realtime/events.js";
import type { MappingRule } from "../config/schema.js";

const GLOBAL_KEY = "__global__";

/** Values available for custom key templates ($SPEC_STREAM_*). */
function templateValues(event: ChangelogEvent): Record<string, string> {
  return {
    SPEC_STREAM_EVENT_TYPE: event.type,
    SPEC_STREAM_WORKSPACE_ID: event.workspaceId,
    SPEC_STREAM_CHAPTER_ID: event.chapterId ?? "",
    SPEC_STREAM_ELEMENT_ID: event.elementId ?? "",
    SPEC_STREAM_ELEMENT_TYPE: event.elementType ?? "",
    SPEC_STREAM_SLICE_ID: event.sliceId ?? "",
  };
}

/**
 * Resolve the concurrency key for an event under a rule.
 *
 * Built-ins: `element` → elementId, `slice` → sliceId, `chapter` → chapterId,
 * `global` → a constant. Anything else is treated as a template string where
 * `$SPEC_STREAM_*` placeholders are substituted.
 *
 * The returned key is namespaced by rule id so different rules never share a lane
 * unless they deliberately use the same `global`/template key.
 */
export function deriveConcurrencyKey(rule: MappingRule, event: ChangelogEvent): string {
  const kind = rule.concurrency.key;
  let raw: string;

  switch (kind) {
    case "element":
      raw = event.elementId ?? GLOBAL_KEY;
      break;
    case "slice":
      raw = event.sliceId ?? GLOBAL_KEY;
      break;
    case "chapter":
      raw = event.chapterId ?? GLOBAL_KEY;
      break;
    case "global":
      raw = GLOBAL_KEY;
      break;
    default:
      raw = substituteTemplate(kind, templateValues(event));
      break;
  }

  return `${rule.id}::${raw}`;
}

/** Replace $NAME and ${NAME} placeholders; unknown placeholders become empty. */
export function substituteTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\$\{?([A-Z0-9_]+)\}?/g, (_m, name: string) => values[name] ?? "");
}
