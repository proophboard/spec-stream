/**
 * Optional `.env` loading, dependency-free.
 *
 * Uses Node's built-in `process.loadEnvFile()` (Node ≥ 20.6). If it isn't available or the
 * file doesn't exist, this is a no-op — existing `process.env` values always win, and the
 * caller still falls back to whatever is already in the environment.
 *
 * Only variables not already present in `process.env` are set, so real environment
 * variables and `--env-file` take precedence over the `.env` file.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load a `.env` file from `dir` into `process.env` if present.
 * Returns the path loaded, or null if nothing was loaded.
 */
export function loadDotenv(dir: string = process.cwd()): string | null {
  const path = resolve(dir, ".env");
  if (!existsSync(path)) return null;

  // Prefer Node's built-in parser (Node ≥ 20.6). It sets vars into process.env.
  const nodeLoad = (process as NodeJS.Process & {
    loadEnvFile?: (p: string) => void;
  }).loadEnvFile;

  if (typeof nodeLoad === "function") {
    try {
      // Built-in overrides existing keys; we snapshot + restore pre-existing ones so that
      // real env vars keep precedence over the file.
      const before = { ...process.env };
      nodeLoad.call(process, path);
      for (const key of Object.keys(before)) {
        if (before[key] !== undefined) process.env[key] = before[key];
      }
      return path;
    } catch {
      // fall through to the minimal parser
    }
  }

  // Minimal fallback parser for older Node: KEY=VALUE lines, no interpolation.
  try {
    const text = readFileSync(path, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (!key || key in process.env) continue; // don't override existing
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
    return path;
  } catch {
    return null;
  }
}
