import { describe, it, expect } from "vitest";
import { PidFile, type PidFileDeps } from "./pidfile.js";

function memDeps(initial: Record<string, string> = {}, alive: Set<number> = new Set()) {
  const files = new Map<string, string>(Object.entries(initial));
  const mkdirs: string[] = [];
  const deps: PidFileDeps = {
    readFile: (p) => files.get(p) ?? "",
    writeFile: (p, data) => files.set(p, data),
    exists: (p) => files.has(p),
    remove: (p) => files.delete(p),
    mkdirp: (dir) => mkdirs.push(dir),
    isAlive: (pid) => alive.has(pid),
  };
  return { deps, files, mkdirs };
}

describe("PidFile", () => {
  it("read returns null when absent", () => {
    const { deps } = memDeps();
    expect(new PidFile("/s/x.pid", deps).read()).toBeNull();
  });

  it("read parses a stored pid", () => {
    const { deps } = memDeps({ "/s/x.pid": "4242\n" });
    expect(new PidFile("/s/x.pid", deps).read()).toBe(4242);
  });

  it("read returns null for invalid content", () => {
    const { deps } = memDeps({ "/s/x.pid": "not-a-pid" });
    expect(new PidFile("/s/x.pid", deps).read()).toBeNull();
  });

  it("write stores the pid and mkdirs the parent", () => {
    const { deps, files, mkdirs } = memDeps();
    new PidFile("/s/x.pid", deps).write(999);
    expect(files.get("/s/x.pid")).toBe("999");
    expect(mkdirs).toContain("/s");
  });

  it("readLive returns the pid when the process is alive", () => {
    const { deps } = memDeps({ "/s/x.pid": "100" }, new Set([100]));
    expect(new PidFile("/s/x.pid", deps).readLive()).toBe(100);
  });

  it("readLive clears a stale pid file and returns null", () => {
    const { deps, files } = memDeps({ "/s/x.pid": "100" }, new Set());
    const pf = new PidFile("/s/x.pid", deps);
    expect(pf.readLive()).toBeNull();
    expect(files.has("/s/x.pid")).toBe(false);
  });

  it("clear removes the file if present", () => {
    const { deps, files } = memDeps({ "/s/x.pid": "1" });
    new PidFile("/s/x.pid", deps).clear();
    expect(files.has("/s/x.pid")).toBe(false);
  });
});
