/**
 * Config discovery and loading.
 *
 * Discovery: honor an explicit path, else search `proophboard.spec-stream.json` from a
 * start directory upward to the filesystem root (cosmiconfig-style).
 *
 * The API key is resolved separately from the environment — never from the config file.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, parse as parsePath } from "node:path";
import { ConfigError, validateConfig, type SpecStreamConfig } from "./schema.js";

export const CONFIG_FILENAME = "proophboard.spec-stream.json";
export const API_KEY_ENV = "PROOPHBOARD_API_KEY";

/**
 * Find the config file by walking up from `startDir`. Returns the absolute path or null.
 * `fileExists` is injectable for testing.
 */
export function discoverConfigPath(
  startDir: string = process.cwd(),
  fileExists: (p: string) => boolean = existsSync,
): string | null {
  let dir = resolve(startDir);
  const { root } = parsePath(dir);

  // Walk up until (and including) the filesystem root.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (fileExists(candidate)) return candidate;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the API key from the environment. Throws a ConfigError if missing or malformed.
 */
export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env[API_KEY_ENV];
  if (!key || key.length === 0) {
    throw new ConfigError(
      `Missing ${API_KEY_ENV}. Set it in your environment or a .env file (never in the config file).`,
    );
  }
  if (!key.startsWith("pb_")) {
    throw new ConfigError(
      `${API_KEY_ENV} does not look like a prooph board API key (expected it to start with "pb_").`,
    );
  }
  return key;
}

export interface LoadedConfig {
  config: SpecStreamConfig;
  configPath: string;
}

export interface LoadOptions {
  /** Explicit config path (from --config). */
  configPath?: string;
  /** Directory to start discovery from (default: cwd). */
  cwd?: string;
  /** Injectable reader for testing. */
  readFile?: (p: string) => string;
  /** Injectable existence check for testing. */
  fileExists?: (p: string) => boolean;
}

/**
 * Load and validate the config. Discovers the file (or uses an explicit path), parses
 * JSON, validates, and injects the resolved config directory.
 *
 * @throws {ConfigError} on missing file, invalid JSON, or schema violations.
 */
export function loadConfig(options: LoadOptions = {}): LoadedConfig {
  const {
    cwd = process.cwd(),
    readFile = (p: string) => readFileSync(p, "utf8"),
    fileExists = existsSync,
  } = options;

  let configPath: string;
  if (options.configPath) {
    configPath = resolve(options.configPath);
    if (!fileExists(configPath)) {
      throw new ConfigError(`Config file not found: ${configPath}`);
    }
  } else {
    const discovered = discoverConfigPath(cwd, fileExists);
    if (!discovered) {
      throw new ConfigError(
        `No ${CONFIG_FILENAME} found in ${cwd} or any parent directory. ` +
          `Create one, or pass --config <path>.`,
      );
    }
    configPath = discovered;
  }

  let text: string;
  try {
    text = readFile(configPath);
  } catch (err) {
    throw new ConfigError(`Could not read config file ${configPath}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${configPath}: ${(err as Error).message}`);
  }

  const config = validateConfig(parsed, dirname(configPath));
  return { config, configPath };
}
