/**
 * Event Router: match a changelog event against the configured mapping rules.
 * Rules are evaluated in order; an event may match zero or more rules.
 *
 * Self-event filtering: by default a rule does NOT match events made by spec-stream's own
 * API-key user (same user id), so triggered agents that write back to the board don't
 * re-trigger themselves. A rule can opt in to its own events with `consumeOwnEvents`.
 */

import type { ChangelogEvent } from "../realtime/events.js";
import type { MappingRule, SpecStreamConfig } from "../config/schema.js";
import { matchesWhen } from "./filters.js";

export interface MatchedTask {
  rule: MappingRule;
  event: ChangelogEvent;
}

/** Identity of the API key's user, used to detect the user's own writes. */
export interface SelfIdentity {
  userId?: string;
  email?: string;
}

/** Does a rule's `on` clause match the event type? */
export function matchesOn(rule: MappingRule, event: ChangelogEvent): boolean {
  if (rule.on === "*") return true;
  return rule.on.includes(event.type);
}

/**
 * Is this event one of "our own" writes? True when the event's user id equals the
 * API-key user's id. If we don't know our own id (endpoint didn't provide it), we can't
 * detect self-events, so this returns false (nothing is treated as self).
 */
export function isOwnEvent(event: ChangelogEvent, self: SelfIdentity): boolean {
  return self.userId !== undefined && event.userId === self.userId;
}

/** Does a rule fully match an event (type + filters + self-event policy)? */
export function ruleMatches(
  rule: MappingRule,
  event: ChangelogEvent,
  self: SelfIdentity,
): boolean {
  if (!matchesOn(rule, event)) return false;
  if (!matchesWhen(rule.when, event)) return false;
  // Skip our own writes unless the rule opts in.
  if (!rule.consumeOwnEvents && isOwnEvent(event, self)) return false;
  return true;
}

export class Router {
  constructor(
    private readonly rules: MappingRule[],
    private readonly self: SelfIdentity = {},
  ) {}

  static fromConfig(config: SpecStreamConfig, self: SelfIdentity = {}): Router {
    return new Router(config.rules, self);
  }

  /** Return every rule that matches the event, preserving config order. */
  match(event: ChangelogEvent): MatchedTask[] {
    const matched: MatchedTask[] = [];
    for (const rule of this.rules) {
      if (ruleMatches(rule, event, this.self)) matched.push({ rule, event });
    }
    return matched;
  }
}
