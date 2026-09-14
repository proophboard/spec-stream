import { describe, it, expect } from "vitest";
import { runCommand } from "./command.js";
import type { SchedulerTask } from "../scheduler/scheduler.js";
import { validateConfig, type SpecStreamConfig } from "../config/schema.js";
import type { ChangelogEvent } from "../realtime/events.js";

function event(overrides: Partial<ChangelogEvent> = {}): ChangelogEvent {
  return {
    id: "e1",
    type: "element-description-changed",
    timestamp: 1,
    workspaceId: "ws",
    chapterId: "ch1",
    elementId: "el1",
    elementName: "Place Order",
    elementType: "command",
    sliceId: "sl1",
    addedByAgent: false,
    createdAt: "t",
    data: {},
    row: { id: "row1", workspace_id: "ws" } as ChangelogEvent["row"],
    ...overrides,
  };
}

/** Build a config with a single rule (shell or command form). */
function config(ruleOverrides: Record<string, unknown>, shell = true): SpecStreamConfig {
  return validateConfig({
    endpoint: "https://x.com",
    shell,
    rules: [{ id: "r", on: "*", ...ruleOverrides }],
  });
}

function task(cfg: SpecStreamConfig, events = [event()]): SchedulerTask {
  return { rule: cfg.rules[0], events, concurrencyKey: "r::el1" };
}

describe("runCommand (real spawn)", () => {
  it("runs a shell command and captures stdout, exit 0", async () => {
    const cfg = config({ run: "echo hello-world" });
    const res = await runCommand(task(cfg), { config: cfg });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("hello-world");
    expect(res.timedOut).toBe(false);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports non-zero exit as not ok", async () => {
    const cfg = config({ run: "exit 3" });
    const res = await runCommand(task(cfg), { config: cfg });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(3);
  });

  it("streams output via onOutput while still capturing it", async () => {
    const cfg = config({ run: "printf 'a\\nb\\n'" });
    const chunks: Array<{ stream: string; chunk: string }> = [];
    const res = await runCommand(task(cfg), {
      config: cfg,
      onOutput: (stream, chunk) => chunks.push({ stream, chunk }),
    });
    // Captured result is intact.
    expect(res.stdout).toBe("a\nb\n");
    // And the same bytes were streamed live.
    const streamed = chunks.filter((c) => c.stream === "stdout").map((c) => c.chunk).join("");
    expect(streamed).toBe("a\nb\n");
  });

  it("passes SPEC_STREAM_* env to the command", async () => {
    const cfg = config({ run: "printf '%s' \"$SPEC_STREAM_ELEMENT_NAME\"" });
    const res = await runCommand(task(cfg), { config: cfg });
    expect(res.stdout).toBe("Place Order");
  });

  it("writes the event JSON to stdin", async () => {
    // node reads stdin and prints the event type
    const cfg = config(
      {
        command: process.execPath,
        args: [
          "-e",
          "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const p=JSON.parse(d);process.stdout.write(p.event.type)})",
        ],
      },
      false,
    );
    const res = await runCommand(task(cfg), { config: cfg });
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("element-description-changed");
  });

  it("captures stderr", async () => {
    const cfg = config({ run: "echo oops 1>&2; exit 1" });
    const res = await runCommand(task(cfg), { config: cfg });
    expect(res.stderr.trim()).toBe("oops");
    expect(res.ok).toBe(false);
  });

  it("times out a long-running command", async () => {
    const cfg = config({
      command: process.execPath,
      args: ["-e", "setTimeout(()=>{}, 10000)"],
      timeout: 150,
    }, false);
    const res = await runCommand(task(cfg), { config: cfg, killGraceMs: 100 });
    expect(res.timedOut).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/timed out/);
  });

  it("never throws on a nonexistent command (shell:false)", async () => {
    const cfg = config(
      { command: "definitely-not-a-real-binary-xyz", args: [] },
      false,
    );
    const res = await runCommand(task(cfg), { config: cfg });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it("runs a batch task (multiple events on stdin)", async () => {
    const cfg = config(
      {
        command: process.execPath,
        args: [
          "-e",
          "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const p=JSON.parse(d);process.stdout.write(p.mode+':'+p.events.length)})",
        ],
      },
      false,
    );
    const res = await runCommand(task(cfg, [event({ id: "a" }), event({ id: "b" })]), {
      config: cfg,
    });
    expect(res.stdout).toBe("batch:2");
  });
});
