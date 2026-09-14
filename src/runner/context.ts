/**
 * Command context: build the environment variables and stdin payload passed to a
 * spawned command. See docs/command-context.md.
 */

import type { SchedulerTask } from "../scheduler/scheduler.js";
import type { ChangelogEvent } from "../realtime/events.js";
import type { MappingRule } from "../config/schema.js";

/** Set a var only when the value is defined and non-empty. */
function put(env: Record<string, string>, key: string, value: string | undefined): void {
  if (value !== undefined && value !== "") env[key] = value;
}

/**
 * Build the SPEC_STREAM_* environment variables for a task. In batch mode the variables
 * describe the first event and BATCH_SIZE reflects the count; the full set is on stdin.
 */
export function buildSpecStreamEnv(task: SchedulerTask): Record<string, string> {
  const event = task.events[0];
  const env: Record<string, string> = {};

  put(env, "SPEC_STREAM_EVENT_ID", event.id);
  put(env, "SPEC_STREAM_EVENT_TYPE", event.type);
  put(env, "SPEC_STREAM_TIMESTAMP", String(event.timestamp));
  put(env, "SPEC_STREAM_WORKSPACE_ID", event.workspaceId);
  put(env, "SPEC_STREAM_CHAPTER_ID", event.chapterId ?? undefined);
  put(env, "SPEC_STREAM_CHAPTER_NAME", event.chapterName);
  put(env, "SPEC_STREAM_ELEMENT_ID", event.elementId);
  put(env, "SPEC_STREAM_ELEMENT_NAME", event.elementName);
  put(env, "SPEC_STREAM_ELEMENT_TYPE", event.elementType);
  put(env, "SPEC_STREAM_SLICE_ID", event.sliceId);
  put(env, "SPEC_STREAM_USER_ID", event.userId);
  env.SPEC_STREAM_ADDED_BY_AGENT = event.addedByAgent ? "true" : "false";
  put(env, "SPEC_STREAM_RULE_ID", task.rule.id);
  put(env, "SPEC_STREAM_CONCURRENCY_KEY", task.concurrencyKey);
  env.SPEC_STREAM_BATCH_SIZE = String(task.events.length);

  return env;
}

export interface SingleStdinPayload {
  mode: "single";
  event: ChangelogEvent;
  row: ChangelogEvent["row"];
}
export interface BatchStdinPayload {
  mode: "batch";
  events: ChangelogEvent[];
  rows: ChangelogEvent["row"][];
}
export type StdinPayload = SingleStdinPayload | BatchStdinPayload;

/** Build the JSON payload written to the command's stdin. */
export function buildStdinPayload(task: SchedulerTask): StdinPayload {
  if (task.events.length > 1) {
    return {
      mode: "batch",
      events: task.events,
      rows: task.events.map((e) => e.row),
    };
  }
  const event = task.events[0];
  return { mode: "single", event, row: event.row };
}

export function serializeStdin(task: SchedulerTask): string {
  return JSON.stringify(buildStdinPayload(task));
}

/**
 * Merge env for a command: process env + global config env + rule env + SPEC_STREAM_*.
 * Later sources win. SPEC_STREAM_* are computed and always applied last.
 */
export function mergeEnv(
  processEnv: NodeJS.ProcessEnv,
  globalEnv: Record<string, string>,
  rule: MappingRule,
  task: SchedulerTask,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(processEnv)) {
    if (v !== undefined) merged[k] = v;
  }
  Object.assign(merged, globalEnv, rule.env, buildSpecStreamEnv(task));
  return merged;
}
