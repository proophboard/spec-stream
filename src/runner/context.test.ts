import { describe, it, expect } from "vitest";
import {
  buildSpecStreamEnv,
  buildStdinPayload,
  serializeStdin,
  mergeEnv,
} from "./context.js";
import type { SchedulerTask } from "../scheduler/scheduler.js";
import { validateConfig, type MappingRule } from "../config/schema.js";
import type { ChangelogEvent } from "../realtime/events.js";

function event(overrides: Partial<ChangelogEvent> = {}): ChangelogEvent {
  return {
    id: "e1",
    type: "element-description-changed",
    timestamp: 1700000000000,
    workspaceId: "ws",
    chapterId: "ch1",
    chapterName: "Checkout",
    elementId: "el1",
    elementName: "Place Order",
    elementType: "command",
    sliceId: "sl1",
    userId: "u1",
    addedByAgent: false,
    createdAt: "t",
    data: { foo: "bar" },
    row: { id: "row1", workspace_id: "ws" } as ChangelogEvent["row"],
    ...overrides,
  };
}

function rule(overrides: Record<string, unknown> = {}): MappingRule {
  return validateConfig({
    endpoint: "https://x.com",
    rules: [{ id: "r", on: "*", run: "echo", env: {}, ...overrides }],
  }).rules[0];
}

function task(events: ChangelogEvent[], r = rule()): SchedulerTask {
  return { rule: r, events, concurrencyKey: "r::el1" };
}

describe("buildSpecStreamEnv", () => {
  it("maps event fields to SPEC_STREAM_* vars", () => {
    const env = buildSpecStreamEnv(task([event()]));
    expect(env.SPEC_STREAM_EVENT_ID).toBe("e1");
    expect(env.SPEC_STREAM_EVENT_TYPE).toBe("element-description-changed");
    expect(env.SPEC_STREAM_TIMESTAMP).toBe("1700000000000");
    expect(env.SPEC_STREAM_WORKSPACE_ID).toBe("ws");
    expect(env.SPEC_STREAM_CHAPTER_ID).toBe("ch1");
    expect(env.SPEC_STREAM_CHAPTER_NAME).toBe("Checkout");
    expect(env.SPEC_STREAM_ELEMENT_ID).toBe("el1");
    expect(env.SPEC_STREAM_ELEMENT_NAME).toBe("Place Order");
    expect(env.SPEC_STREAM_ELEMENT_TYPE).toBe("command");
    expect(env.SPEC_STREAM_SLICE_ID).toBe("sl1");
    expect(env.SPEC_STREAM_USER_ID).toBe("u1");
    expect(env.SPEC_STREAM_ADDED_BY_AGENT).toBe("false");
    expect(env.SPEC_STREAM_RULE_ID).toBe("r");
    expect(env.SPEC_STREAM_CONCURRENCY_KEY).toBe("r::el1");
    expect(env.SPEC_STREAM_BATCH_SIZE).toBe("1");
  });

  it("omits undefined/empty optional vars", () => {
    const env = buildSpecStreamEnv(task([event({ elementName: undefined, sliceId: undefined })]));
    expect(env).not.toHaveProperty("SPEC_STREAM_ELEMENT_NAME");
    expect(env).not.toHaveProperty("SPEC_STREAM_SLICE_ID");
  });

  it("reports batch size and uses first event for scalar vars", () => {
    const env = buildSpecStreamEnv(task([event({ id: "a" }), event({ id: "b" })]));
    expect(env.SPEC_STREAM_EVENT_ID).toBe("a");
    expect(env.SPEC_STREAM_BATCH_SIZE).toBe("2");
  });

  it("sets addedByAgent true", () => {
    const env = buildSpecStreamEnv(task([event({ addedByAgent: true })]));
    expect(env.SPEC_STREAM_ADDED_BY_AGENT).toBe("true");
  });
});

describe("buildStdinPayload", () => {
  it("produces single payload for one event", () => {
    const p = buildStdinPayload(task([event()]));
    expect(p.mode).toBe("single");
    if (p.mode === "single") {
      expect(p.event.id).toBe("e1");
      expect(p.row.id).toBe("row1");
    }
  });

  it("produces batch payload for multiple events", () => {
    const p = buildStdinPayload(task([event({ id: "a" }), event({ id: "b" })]));
    expect(p.mode).toBe("batch");
    if (p.mode === "batch") {
      expect(p.events.map((e) => e.id)).toEqual(["a", "b"]);
      expect(p.rows).toHaveLength(2);
    }
  });

  it("serializes to valid JSON", () => {
    const json = serializeStdin(task([event()]));
    const parsed = JSON.parse(json);
    expect(parsed.mode).toBe("single");
    expect(parsed.event.data.foo).toBe("bar");
  });
});

describe("mergeEnv", () => {
  it("merges process, global, rule, and SPEC_STREAM_* with correct precedence", () => {
    const merged = mergeEnv(
      { PATH: "/bin", SHARED: "proc" },
      { SHARED: "global", G: "1" },
      rule({ env: { SHARED: "rule", R: "2" } }),
      task([event()]),
    );
    expect(merged.PATH).toBe("/bin");
    expect(merged.SHARED).toBe("rule"); // rule wins over global/process
    expect(merged.G).toBe("1");
    expect(merged.R).toBe("2");
    expect(merged.SPEC_STREAM_EVENT_ID).toBe("e1");
  });
});
