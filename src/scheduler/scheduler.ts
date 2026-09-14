/**
 * Scheduler: the single authority on WHEN a matched task runs.
 *
 * Per (rule + concurrency key) "lane", it applies the rule's mode:
 *   - parallel : run immediately (bounded only by global maxConcurrent / rule.max)
 *   - queue    : one at a time per lane; extra tasks wait FIFO
 *   - debounce : run once after `wait` ms of quiet, with the latest event
 *   - dedupe   : while a lane run is active, drop further tasks (keep none)
 *   - batch    : collect for `wait` ms (or up to maxBatch), run once with the batch
 *
 * Global `maxConcurrent` caps simultaneous runs across all lanes; `rule.max` caps
 * simultaneous runs sharing a lane key.
 *
 * The scheduler is transport-agnostic: it calls an injected `runner(task)` that returns
 * a promise resolving when the command finishes. Timers are injectable for testing.
 */

import type { ChangelogEvent } from "../realtime/events.js";
import type { MappingRule } from "../config/schema.js";
import { deriveConcurrencyKey } from "./keys.js";

export interface SchedulerTask {
  rule: MappingRule;
  /** One event (single modes) or the batch (batch mode); always non-empty. */
  events: ChangelogEvent[];
  concurrencyKey: string;
}

export type TaskRunner = (task: SchedulerTask) => Promise<void>;

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};

interface Lane {
  key: string;
  rule: MappingRule;
  /** Number of currently running invocations in this lane. */
  running: number;
  /** FIFO waiting tasks (queue mode). */
  queue: ChangelogEvent[];
  /** Pending single event (debounce keep-last while running). */
  pending?: ChangelogEvent;
  /** Debounce/batch timer. */
  timer?: ReturnType<typeof setTimeout>;
  /** Accumulating batch. */
  batch: ChangelogEvent[];
}

export interface SchedulerStats {
  running: number;
  lanes: number;
  dropped: number;
}

export class Scheduler {
  private lanes = new Map<string, Lane>();
  private globalRunning = 0;
  private dropped = 0;
  private readonly maxConcurrent: number;
  private readonly timers: Timers;
  private readonly runner: TaskRunner;
  /** Tasks that are ready but blocked by the global cap, retried when a slot frees. */
  private globalWaiters: Array<() => void> = [];

  constructor(opts: { maxConcurrent: number; runner: TaskRunner; timers?: Timers }) {
    this.maxConcurrent = opts.maxConcurrent;
    this.runner = opts.runner;
    this.timers = opts.timers ?? realTimers;
  }

  stats(): SchedulerStats {
    return { running: this.globalRunning, lanes: this.lanes.size, dropped: this.dropped };
  }

  private laneFor(rule: MappingRule, key: string): Lane {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { key, rule, running: 0, queue: [], batch: [] };
      this.lanes.set(key, lane);
    }
    return lane;
  }

  /** Submit a matched (rule, event) pair for scheduling. */
  submit(rule: MappingRule, event: ChangelogEvent): void {
    const key = deriveConcurrencyKey(rule, event);
    const lane = this.laneFor(rule, key);

    switch (rule.concurrency.mode) {
      case "parallel":
        void this.startRun(lane, [event]);
        break;
      case "queue":
        lane.queue.push(event);
        this.pumpQueue(lane);
        break;
      case "dedupe":
        if (lane.running > 0) {
          this.dropped++;
          return;
        }
        void this.startRun(lane, [event]);
        break;
      case "debounce":
        this.scheduleDebounce(lane, event);
        break;
      case "batch":
        this.scheduleBatch(lane, event);
        break;
    }
  }

  private canStart(): boolean {
    return this.globalRunning < this.maxConcurrent;
  }

  private pumpQueue(lane: Lane): void {
    while (
      lane.queue.length > 0 &&
      lane.running < lane.rule.concurrency.max &&
      this.canStart()
    ) {
      const event = lane.queue.shift()!;
      void this.startRun(lane, [event]);
    }
  }

  private scheduleDebounce(lane: Lane, event: ChangelogEvent): void {
    lane.pending = event; // keep-last
    if (lane.timer) this.timers.clearTimeout(lane.timer);
    lane.timer = this.timers.setTimeout(() => {
      lane.timer = undefined;
      this.fireDebounce(lane);
    }, lane.rule.concurrency.wait);
  }

  private fireDebounce(lane: Lane): void {
    if (lane.pending === undefined) return;
    // If the lane is at capacity, keep pending and retry when a run finishes.
    if (lane.running >= lane.rule.concurrency.max || !this.canStart()) {
      return;
    }
    const event = lane.pending;
    lane.pending = undefined;
    void this.startRun(lane, [event]);
  }

  private scheduleBatch(lane: Lane, event: ChangelogEvent): void {
    lane.batch.push(event);
    if (lane.batch.length >= lane.rule.concurrency.maxBatch) {
      if (lane.timer) {
        this.timers.clearTimeout(lane.timer);
        lane.timer = undefined;
      }
      this.fireBatch(lane);
      return;
    }
    if (!lane.timer) {
      lane.timer = this.timers.setTimeout(() => {
        lane.timer = undefined;
        this.fireBatch(lane);
      }, lane.rule.concurrency.wait);
    }
  }

  private fireBatch(lane: Lane): void {
    if (lane.batch.length === 0) return;
    if (lane.running >= lane.rule.concurrency.max || !this.canStart()) {
      // Hold the batch; retry when a run finishes.
      return;
    }
    const events = lane.batch;
    lane.batch = [];
    void this.startRun(lane, events);
  }

  private async startRun(lane: Lane, events: ChangelogEvent[]): Promise<void> {
    lane.running++;
    this.globalRunning++;
    const task: SchedulerTask = { rule: lane.rule, events, concurrencyKey: lane.key };
    try {
      await this.runner(task);
    } catch {
      // Runner must not throw; guard anyway so the loop never breaks.
    } finally {
      lane.running--;
      this.globalRunning--;
      this.onRunFinished(lane);
    }
  }

  private onRunFinished(lane: Lane): void {
    // Resume held work in this lane, then wake global waiters for other lanes.
    switch (lane.rule.concurrency.mode) {
      case "queue":
        this.pumpQueue(lane);
        break;
      case "debounce":
        if (lane.pending !== undefined && !lane.timer) this.fireDebounce(lane);
        break;
      case "batch":
        if (lane.batch.length > 0 && !lane.timer) this.fireBatch(lane);
        break;
      default:
        break;
    }
    this.cleanupLane(lane);

    // A global slot freed: let other lanes re-check (queue lanes waiting on the cap).
    const waiters = this.globalWaiters;
    this.globalWaiters = [];
    for (const w of waiters) w();
    for (const other of this.lanes.values()) {
      if (other === lane) continue;
      this.pumpQueue(other);
      if (other.rule.concurrency.mode === "debounce" && other.pending !== undefined && !other.timer) {
        this.fireDebounce(other);
      }
      if (other.rule.concurrency.mode === "batch" && other.batch.length > 0 && !other.timer) {
        this.fireBatch(other);
      }
    }
  }

  private cleanupLane(lane: Lane): void {
    if (
      lane.running === 0 &&
      lane.queue.length === 0 &&
      lane.batch.length === 0 &&
      lane.pending === undefined &&
      !lane.timer
    ) {
      this.lanes.delete(lane.key);
    }
  }

  /** Number of tasks not yet started (queued/pending/batched). For diagnostics/shutdown. */
  pendingCount(): number {
    let n = 0;
    for (const lane of this.lanes.values()) {
      n += lane.queue.length + lane.batch.length + (lane.pending !== undefined ? 1 : 0);
    }
    return n;
  }

  /**
   * Cancel all not-yet-started work (used on shutdown). Running tasks are unaffected.
   */
  cancelPending(): void {
    for (const lane of this.lanes.values()) {
      if (lane.timer) {
        this.timers.clearTimeout(lane.timer);
        lane.timer = undefined;
      }
      lane.queue = [];
      lane.batch = [];
      lane.pending = undefined;
      this.cleanupLane(lane);
    }
  }
}
