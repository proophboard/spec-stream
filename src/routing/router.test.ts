import { describe, it, expect } from "vitest";
import { Router, ruleMatches, matchesOn, isOwnEvent } from "./router.js";
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
    userId: "other-user",
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
    endpoint: "https://x.com/api",
    rules: [{ on: "element-description-changed", run: "echo", ...overrides }],
  });
  return cfg.rules[0];
}

const noSelf = {};
const self = { userId: "self-user", email: "api@machine" };

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
    expect(matchesWhen({ elementType: ["command"] }, event())).toBe(true);
    expect(matchesWhen({ elementType: ["event"] }, event())).toBe(false);
  });
  it("matches context and chapter filters", () => {
    expect(matchesWhen({ context: ["Ordering"], chapterName: ["Checkout"] }, event())).toBe(true);
    expect(matchesWhen({ chapterId: ["other"] }, event())).toBe(false);
  });
  it("fails a filter when the event value is missing", () => {
    expect(matchesWhen({ elementType: ["command"] }, event({ elementType: undefined }))).toBe(false);
  });
  it("does NOT exclude agent events by default (no addedByAgent filter)", () => {
    expect(matchesWhen({}, event({ addedByAgent: true }))).toBe(true);
    expect(matchesWhen({}, event({ addedByAgent: false }))).toBe(true);
  });
  it("matches addedByAgent only when explicitly set", () => {
    expect(matchesWhen({ addedByAgent: true }, event({ addedByAgent: true }))).toBe(true);
    expect(matchesWhen({ addedByAgent: true }, event({ addedByAgent: false }))).toBe(false);
    expect(matchesWhen({ addedByAgent: false }, event({ addedByAgent: false }))).toBe(true);
    expect(matchesWhen({ addedByAgent: false }, event({ addedByAgent: true }))).toBe(false);
  });
});

describe("isOwnEvent", () => {
  it("true when event userId equals self userId", () => {
    expect(isOwnEvent(event({ userId: "self-user" }), self)).toBe(true);
  });
  it("false for a different user", () => {
    expect(isOwnEvent(event({ userId: "other-user" }), self)).toBe(false);
  });
  it("false when self identity is unknown", () => {
    expect(isOwnEvent(event({ userId: "self-user" }), noSelf)).toBe(false);
  });
});

describe("ruleMatches — self-event policy", () => {
  it("matches others' events by default", () => {
    expect(ruleMatches(rule(), event({ userId: "other-user" }), self)).toBe(true);
  });
  it("skips the user's own events by default", () => {
    expect(ruleMatches(rule(), event({ userId: "self-user" }), self)).toBe(false);
  });
  it("consumes own events when consumeOwnEvents=true", () => {
    const r = rule({ consumeOwnEvents: true });
    expect(ruleMatches(r, event({ userId: "self-user" }), self)).toBe(true);
  });
  it("does not treat anything as self when identity is unknown", () => {
    expect(ruleMatches(rule(), event({ userId: "self-user" }), noSelf)).toBe(true);
  });
  it("still requires on + when to match", () => {
    const r = rule({ on: "element-description-changed", when: { elementType: "command" } });
    expect(ruleMatches(r, event(), self)).toBe(true);
    expect(ruleMatches(r, event({ elementType: "event" }), self)).toBe(false);
    expect(ruleMatches(r, event({ type: "chapter-added" }), self)).toBe(false);
  });
});

describe("Router", () => {
  it("returns all matching rules in config order", () => {
    const cfg = validateConfig({
      endpoint: "https://x.com/api",
      rules: [
        { id: "a", on: "*", run: "x" },
        { id: "b", on: "element-description-changed", run: "y" },
        { id: "c", on: "chapter-added", run: "z" },
      ],
    });
    const router = Router.fromConfig(cfg, self);
    const matched = router.match(event({ userId: "other-user" }));
    expect(matched.map((m) => m.rule.id)).toEqual(["a", "b"]);
  });

  it("filters out the user's own events except for consumeOwnEvents rules", () => {
    const cfg = validateConfig({
      endpoint: "https://x.com/api",
      rules: [
        { id: "normal", on: "*", run: "x" },
        { id: "own", on: "*", run: "y", consumeOwnEvents: true },
      ],
    });
    const router = Router.fromConfig(cfg, self);
    // Own event: only the consumeOwnEvents rule matches
    expect(router.match(event({ userId: "self-user" })).map((m) => m.rule.id)).toEqual(["own"]);
    // Other user's event: both match
    expect(router.match(event({ userId: "other-user" })).map((m) => m.rule.id)).toEqual([
      "normal",
      "own",
    ]);
  });

  it("returns empty when nothing matches", () => {
    const cfg = validateConfig({
      endpoint: "https://x.com/api",
      rules: [{ id: "a", on: "slice-added", run: "x" }],
    });
    expect(Router.fromConfig(cfg, self).match(event())).toEqual([]);
  });
});
