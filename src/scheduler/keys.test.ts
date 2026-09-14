import { describe, it, expect } from "vitest";
import { deriveConcurrencyKey, substituteTemplate } from "./keys.js";
import { validateConfig, type MappingRule } from "../config/schema.js";
import type { ChangelogEvent } from "../realtime/events.js";

function event(overrides: Partial<ChangelogEvent> = {}): ChangelogEvent {
  return {
    id: "e1",
    type: "element-description-changed",
    timestamp: 1,
    workspaceId: "ws",
    chapterId: "ch1",
    elementId: "el1",
    elementType: "command",
    sliceId: "sl1",
    addedByAgent: false,
    createdAt: "t",
    data: {},
    row: {} as ChangelogEvent["row"],
    ...overrides,
  };
}

function ruleWithKey(key: string, on = "element-description-changed"): MappingRule {
  return validateConfig({
    endpoint: "https://x.com",
    rules: [{ id: "r", on, run: "x", concurrency: { key } }],
  }).rules[0];
}

describe("substituteTemplate", () => {
  it("substitutes $NAME and ${NAME}", () => {
    expect(substituteTemplate("$A-${B}", { A: "1", B: "2" })).toBe("1-2");
  });
  it("replaces unknown placeholders with empty", () => {
    expect(substituteTemplate("$X", {})).toBe("");
  });
});

describe("deriveConcurrencyKey", () => {
  it("element key uses elementId, namespaced by rule id", () => {
    expect(deriveConcurrencyKey(ruleWithKey("element"), event())).toBe("r::el1");
  });
  it("slice key uses sliceId", () => {
    expect(deriveConcurrencyKey(ruleWithKey("slice"), event())).toBe("r::sl1");
  });
  it("chapter key uses chapterId", () => {
    expect(deriveConcurrencyKey(ruleWithKey("chapter"), event())).toBe("r::ch1");
  });
  it("global key is constant per rule", () => {
    const r = ruleWithKey("global");
    expect(deriveConcurrencyKey(r, event({ elementId: "a" }))).toBe(
      deriveConcurrencyKey(r, event({ elementId: "b" })),
    );
  });
  it("custom template key substitutes event values", () => {
    const r = ruleWithKey("$SPEC_STREAM_CHAPTER_ID:$SPEC_STREAM_ELEMENT_TYPE", "*");
    expect(deriveConcurrencyKey(r, event())).toBe("r::ch1:command");
  });
  it("falls back to global sentinel when id missing", () => {
    const r = ruleWithKey("element");
    // Different events with no elementId share the same lane
    const k1 = deriveConcurrencyKey(r, event({ elementId: undefined, id: "x" }));
    const k2 = deriveConcurrencyKey(r, event({ elementId: undefined, id: "y" }));
    expect(k1).toBe(k2);
  });
});
