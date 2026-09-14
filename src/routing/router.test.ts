import { describe, it, expect } from "vitest";
import { Router, ruleMatches, matchesOn } from "./router.js";
import { matchesWhen } from "./filters.js";
import { validateConfig, type MappingRule } from "../config/schema.js";
import type { ChangelogEvent } from "../realtime/events.js";

function event(overrides: Partial<ChangelogEvent> = {}): ChangelogEvent {
  return {
    id: "e1",
    type: "element-description-changed",
    timestamp: 1,
    workspaceId: "ws",
    chapterId: "ch1",
    chapterName: "Checkout",
    elementId: "el1",
    elementName: "Place Order",
    elementType: "command",
    sliceId: "sl1",
    userId: "u1",
    context: "Ordering",
    addedByAgent: false,
    createdAt: "2026-09-14T10:00:00Z",
    data: {},
    row: {} as ChangelogEvent["row"],
    ...overrides,
  };
}

function rule(overrides: Record<string, unknown> = {}): MappingRule {
  const cfg = validateConfig({
    endpoint: "https://x.com",
    rules: [{ on: "element-description-changed", run: "echo", ...overrides }],
  });
  return cfg.rules[0];
}

describe("matchesOn", () => {
  it("matches wildcard", () => {
    expect(matchesOn(rule({ on: "*" }), event())).toBe(true);
  });
  it("matches a listed type", () => {
    expect(matchesOn(rule({ on: ["element-added", "element-description-changed"] }), event())).toBe(
      true,
    );
  });
  it("rejects an unlisted type", () => {
    expect(matchesOn(rule({ on: "chapter-added" }), event())).toBe(false);
  });
});

describe("matchesWhen", () => {
  it("passes when no filters", () => {
    expect(matchesWhen({}, event())).toBe(true);
  });
  it("matches elementType filter", () => {
    expect(matchesWhen({ elementType: ["command"], addedByAgent: false }, event())).toBe(true);
    expect(matchesWhen({ elementType: ["event"], addedByAgent: false }, event())).toBe(false);
  });
  it("matches context and chapter filters", () => {
    expect(
      matchesWhen({ context: ["Ordering"], chapterName: ["Checkout"], addedByAgent: false }, event()),
    ).toBe(true);
    expect(matchesWhen({ chapterId: ["other"], addedByAgent: false }, event())).toBe(false);
  });
  it("fails a filter when the event value is missing", () => {
    expect(
      matchesWhen({ elementType: ["command"], addedByAgent: false }, event({ elementType: undefined })),
    ).toBe(false);
  });
  it("excludes agent events by default", () => {
    expect(matchesWhen({}, event({ addedByAgent: true }))).toBe(false);
  });
  it("includes agent events when opted in", () => {
    expect(matchesWhen({ addedByAgent: true }, event({ addedByAgent: true }))).toBe(true);
    expect(matchesWhen({ addedByAgent: true }, event({ addedByAgent: false }))).toBe(false);
  });
});

describe("ruleMatches", () => {
  it("requires both on and when to match", () => {
    const r = rule({ on: "element-description-changed", when: { elementType: "command" } });
    expect(ruleMatches(r, event())).toBe(true);
    expect(ruleMatches(r, event({ elementType: "event" }))).toBe(false);
    expect(ruleMatches(r, event({ type: "chapter-added" }))).toBe(false);
  });
});

describe("Router", () => {
  it("returns all matching rules in config order", () => {
    const cfg = validateConfig({
      endpoint: "https://x.com",
      rules: [
        { id: "a", on: "*", run: "x" },
        { id: "b", on: "element-description-changed", run: "y" },
        { id: "c", on: "chapter-added", run: "z" },
      ],
    });
    const router = Router.fromConfig(cfg);
    const matched = router.match(event());
    expect(matched.map((m) => m.rule.id)).toEqual(["a", "b"]);
  });

  it("returns empty when nothing matches", () => {
    const cfg = validateConfig({
      endpoint: "https://x.com",
      rules: [{ id: "a", on: "slice-added", run: "x" }],
    });
    expect(Router.fromConfig(cfg).match(event())).toEqual([]);
  });

  it("skips agent events for default rules but not opted-in ones", () => {
    const cfg = validateConfig({
      endpoint: "https://x.com",
      rules: [
        { id: "human", on: "*", run: "x" },
        { id: "agent", on: "*", run: "y", when: { addedByAgent: true } },
      ],
    });
    const router = Router.fromConfig(cfg);
    expect(router.match(event({ addedByAgent: true })).map((m) => m.rule.id)).toEqual(["agent"]);
    expect(router.match(event({ addedByAgent: false })).map((m) => m.rule.id)).toEqual(["human"]);
  });
});
