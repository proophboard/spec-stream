import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Scheduler, type SchedulerTask } from "./scheduler.js";
import { validateConfig, type MappingRule, type SpecStreamConfig } from "../config/schema.js";
import type { ChangelogEvent } from "../realtime/events.js";

function event(overrides: Partial<ChangelogEvent> = {}): ChangelogEvent {
  return {
    id: "e" + Math.random(),
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

function makeRule(concurrency: Record<string, unknown>, on = "*"): MappingRule {
  const cfg: SpecStreamConfig = validateConfig({
    endpoint: "https://x.com",
    rules: [{ id: "r", on, run: "x", concurrency }],
  });
  return cfg.rules[0];
}

/** A runner whose invocations can be resolved manually, recording tasks. */
function deferredRunner() {
  const calls: SchedulerTask[] = [];
  const resolvers: Array<() => void> = [];
  const runner = (task: SchedulerTask) => {
    calls.push(task);
    return new Promise<void>((resolve) => {
      resolvers.push(resolve);
    });
  };
  return {
    runner,
    calls,
    resolveNext() {
      const r = resolvers.shift();
      if (r) r();
    },
    resolveAll() {
      while (resolvers.length) resolvers.shift()!();
    },
    get started() {
      return calls.length;
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("parallel mode", () => {
  it("runs immediately, bounded by maxConcurrent", async () => {
    const d = deferredRunner();
    const s = new Scheduler({ maxConcurrent: 2, runner: d.runner });
    const rule = makeRule({ mode: "parallel", key: "global" });
    s.submit(rule, event());
    s.submit(rule, event());
    expect(d.started).toBe(2);
    expect(s.stats().running).toBe(2);
  });
});

describe("queue mode", () => {
  it("runs one at a time per lane (max 1)", async () => {
    const d = deferredRunner();
    const s = new Scheduler({ maxConcurrent: 10, runner: d.runner });
    const rule = makeRule({ mode: "queue", key: "element", max: 1 });

    s.submit(rule, event({ elementId: "A" }));
    s.submit(rule, event({ elementId: "A" }));
    s.submit(rule, event({ elementId: "A" }));
    expect(d.started).toBe(1); // only first runs

    d.resolveNext();
    await Promise.resolve();
    await Promise.resolve();
    expect(d.started).toBe(2); // next dequeued

    d.resolveAll();
    await Promise.resolve();
    await Promise.resolve();
    expect(d.started).toBe(3);
  });

  it("different lanes (elements) run in parallel", () => {
    const d = deferredRunner();
    const s = new Scheduler({ maxConcurrent: 10, runner: d.runner });
    const rule = makeRule({ mode: "queue", key: "element", max: 1 });
    s.submit(rule, event({ elementId: "A" }));
    s.submit(rule, event({ elementId: "B" }));
    expect(d.started).toBe(2);
  });
});

describe("debounce mode", () => {
  it("collapses a burst into a single run with the latest event", () => {
    const d = deferredRunner();
    const s = new Scheduler({ maxConcurrent: 10, runner: d.runner });
    const rule = makeRule({ mode: "debounce", key: "element", wait: 1000, max: 1 });

    s.submit(rule, event({ elementId: "A", id: "1" }));
    vi.advanceTimersByTime(500);
    s.submit(rule, event({ elementId: "A", id: "2" }));
    vi.advanceTimersByTime(500);
    expect(d.started).toBe(0); // timer reset by second submit
    vi.advanceTimersByTime(500);
    expect(d.started).toBe(1);
    expect(d.calls[0].events[0].id).toBe("2"); // latest event
  });

  it("holds a new edit until the running command finishes (no competitor)", async () => {
    const d = deferredRunner();
    const s = new Scheduler({ maxConcurrent: 10, runner: d.runner });
    const rule = makeRule({ mode: "debounce", key: "element", wait: 1000, max: 1 });

    s.submit(rule, event({ elementId: "A", id: "1" }));
    vi.advanceTimersByTime(1000);
    expect(d.started).toBe(1); // first run in flight

    // New edit arrives while running
    s.submit(rule, event({ elementId: "A", id: "2" }));
    vi.advanceTimersByTime(1000);
    expect(d.started).toBe(1); // still only one — held because max=1 and running

    d.resolveNext(); // first finishes
    await Promise.resolve();
    await Promise.resolve();
    expect(d.started).toBe(2); // held edit now runs
    expect(d.calls[1].events[0].id).toBe("2");
  });
});

describe("dedupe mode", () => {
  it("drops tasks while a lane run is active", async () => {
    const d = deferredRunner();
    const s = new Scheduler({ maxConcurrent: 10, runner: d.runner });
    const rule = makeRule({ mode: "dedupe", key: "element", max: 1 });

    s.submit(rule, event({ elementId: "A" }));
    s.submit(rule, event({ elementId: "A" })); // dropped
    s.submit(rule, event({ elementId: "A" })); // dropped
    expect(d.started).toBe(1);
    expect(s.stats().dropped).toBe(2);

    d.resolveNext();
    await Promise.resolve();
    await Promise.resolve();
    // After completion a new submit runs again
    s.submit(rule, event({ elementId: "A" }));
    expect(d.started).toBe(2);
  });
});

describe("batch mode", () => {
  it("collects events over the wait window and runs once", () => {
    const d = deferredRunner();
    const s = new Scheduler({ maxConcurrent: 10, runner: d.runner });
    const rule = makeRule({ mode: "batch", key: "chapter", wait: 1000, maxBatch: 50 });

    s.submit(rule, event({ chapterId: "C", id: "1" }));
    s.submit(rule, event({ chapterId: "C", id: "2" }));
    s.submit(rule, event({ chapterId: "C", id: "3" }));
    expect(d.started).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(d.started).toBe(1);
    expect(d.calls[0].events.map((e) => e.id)).toEqual(["1", "2", "3"]);
  });

  it("flushes early when maxBatch reached", () => {
    const d = deferredRunner();
    const s = new Scheduler({ maxConcurrent: 10, runner: d.runner });
    const rule = makeRule({ mode: "batch", key: "chapter", wait: 10000, maxBatch: 2 });
    s.submit(rule, event({ chapterId: "C", id: "1" }));
    s.submit(rule, event({ chapterId: "C", id: "2" }));
    expect(d.started).toBe(1); // flushed at 2 without waiting
    expect(d.calls[0].events).toHaveLength(2);
  });
});

describe("global maxConcurrent", () => {
  it("caps simultaneous runs across lanes and resumes when a slot frees", async () => {
    const d = deferredRunner();
    const s = new Scheduler({ maxConcurrent: 1, runner: d.runner });
    const rule = makeRule({ mode: "queue", key: "element", max: 1 });

    s.submit(rule, event({ elementId: "A" }));
    s.submit(rule, event({ elementId: "B" }));
    expect(d.started).toBe(1); // global cap = 1

    d.resolveNext();
    await Promise.resolve();
    await Promise.resolve();
    expect(d.started).toBe(2); // B runs after A frees the slot
  });
});

describe("cancelPending", () => {
  it("clears queued/batched/pending without affecting running", () => {
    const d = deferredRunner();
    const s = new Scheduler({ maxConcurrent: 1, runner: d.runner });
    const rule = makeRule({ mode: "queue", key: "element", max: 1 });
    s.submit(rule, event({ elementId: "A" }));
    s.submit(rule, event({ elementId: "A" }));
    expect(s.pendingCount()).toBe(1);
    s.cancelPending();
    expect(s.pendingCount()).toBe(0);
    expect(s.stats().running).toBe(1); // A still running
  });
});
