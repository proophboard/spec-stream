/**
 * Event Router: match a changelog event against the configured mapping rules.
 * Rules are evaluated in order; an event may match zero or more rules.
 */

import type { ChangelogEvent } from "../realtime/events.js";
import type { MappingRule, SpecStreamConfig } from "../config/schema.js";
import { matchesWhen } from "./filters.js";

export interface MatchedTask {
  rule: MappingRule;
  event: ChangelogEvent;
}

/** Does a rule's `on` clause match the event type? */
export function matchesOn(rule: MappingRule, event: ChangelogEvent): boolean {
  if (rule.on === "*") return true;
  return rule.on.includes(event.type);
}

/** Does a rule fully match an event (type + filters)? */
export function ruleMatches(rule: MappingRule, event: ChangelogEvent): boolean {
  return matchesOn(rule, event) && matchesWhen(rule.when, event);
}

export class Router {
  constructor(private readonly rules: MappingRule[]) {}

  static fromConfig(config: SpecStreamConfig): Router {
    return new Router(config.rules);
  }

  /** Return every rule that matches the event, preserving config order. */
  match(event: ChangelogEvent): MatchedTask[] {
    const matched: MatchedTask[] = [];
    for (const rule of this.rules) {
      if (ruleMatches(rule, event)) matched.push({ rule, event });
    }
    return matched;
  }
}
