/**
 * Config schema, defaults, and validation for `proophboard.spec-stream.json`.
 *
 * Validation is hand-rolled (no schema dependency) to keep the tool lightweight. It
 * fails fast with precise messages — invalid config is a startup error (AGENT.md §9).
 */

export type ConcurrencyMode = "parallel" | "queue" | "debounce" | "dedupe" | "batch";
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/** Built-in concurrency key derivations, or a custom template string using $SPEC_STREAM_*. */
export type ConcurrencyKeyKind = "element" | "slice" | "chapter" | "global" | (string & {});

export interface ConcurrencyConfig {
  key: ConcurrencyKeyKind;
  mode: ConcurrencyMode;
  /** ms — used by debounce and batch. */
  wait: number;
  /** per-rule concurrent cap. */
  max: number;
  /** batch mode: flush when this many events collected. */
  maxBatch: number;
}

export interface WhenFilter {
  elementType?: string[];
  context?: string[];
  chapterId?: string[];
  chapterName?: string[];
  /** Match events produced by an automated actor. Defaults to false (agent events ignored). */
  addedByAgent?: boolean;
}

export interface MappingRule {
  id: string;
  /** Event type(s) this rule reacts to, or "*" for all. */
  on: string[] | "*";
  when: WhenFilter;
  /** Shell command string (when shell=true). Mutually exclusive with command/args. */
  run?: string;
  /** Executable (when shell=false). */
  command?: string;
  args: string[];
  /** Working directory, resolved relative to the config file dir. */
  cwd?: string;
  /** Hard timeout in ms; the child is killed and the run marked failed. */
  timeout?: number;
  env: Record<string, string>;
  concurrency: ConcurrencyConfig;
}

export interface SpecStreamConfig {
  endpoint: string;
  logDir?: string;
  stateDir?: string;
  logLevel: LogLevel;
  maxConcurrent: number;
  drainTimeout: number;
  shell: boolean;
  env: Record<string, string>;
  rules: MappingRule[];
  /** Transport: "realtime" (default) or "poll" (degraded fallback). */
  transport: "realtime" | "poll";
  /** Absolute path of the resolved config file dir (set by the loader). */
  configDir: string;
}

const CONCURRENCY_MODES: ConcurrencyMode[] = [
  "parallel",
  "queue",
  "debounce",
  "dedupe",
  "batch",
];
const LOG_LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error"];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Coerce a string|string[] field into string[]; undefined stays undefined. */
function toStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value as string[];
  }
  throw new ConfigError(`${path} must be a string or array of strings`);
}

function validateEnv(value: unknown, path: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new ConfigError(`${path} must be an object`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") throw new ConfigError(`${path}.${k} must be a string`);
    out[k] = v;
  }
  return out;
}

function defaultConcurrencyKey(onTypes: string[] | "*"): ConcurrencyKeyKind {
  // Element events default to per-element; everything else defaults to global.
  const types = onTypes === "*" ? [] : onTypes;
  const allElement = types.length > 0 && types.every((t) => t.startsWith("element-"));
  return allElement ? "element" : "global";
}

function validateConcurrency(
  raw: unknown,
  on: string[] | "*",
  path: string,
): ConcurrencyConfig {
  const c = isPlainObject(raw) ? raw : {};

  const mode = (c.mode ?? "queue") as ConcurrencyMode;
  if (!CONCURRENCY_MODES.includes(mode)) {
    throw new ConfigError(
      `${path}.mode must be one of ${CONCURRENCY_MODES.join(", ")} (got "${String(c.mode)}")`,
    );
  }

  const key = (c.key ?? defaultConcurrencyKey(on)) as ConcurrencyKeyKind;
  if (typeof key !== "string" || key.length === 0) {
    throw new ConfigError(`${path}.key must be a non-empty string`);
  }

  const wait = c.wait ?? 2000;
  if (typeof wait !== "number" || wait < 0) {
    throw new ConfigError(`${path}.wait must be a non-negative number (ms)`);
  }

  const max = c.max ?? (mode === "parallel" ? Number.POSITIVE_INFINITY : 1);
  if (typeof max !== "number" || max < 1) {
    throw new ConfigError(`${path}.max must be a number >= 1`);
  }

  const maxBatch = c.maxBatch ?? 50;
  if (typeof maxBatch !== "number" || maxBatch < 1) {
    throw new ConfigError(`${path}.maxBatch must be a number >= 1`);
  }

  return { key, mode, wait, max, maxBatch };
}

function validateRule(raw: unknown, index: number): MappingRule {
  const path = `rules[${index}]`;
  if (!isPlainObject(raw)) throw new ConfigError(`${path} must be an object`);

  // on
  let on: string[] | "*";
  if (raw.on === "*") {
    on = "*";
  } else {
    const arr = toStringArray(raw.on, `${path}.on`);
    if (!arr || arr.length === 0) {
      throw new ConfigError(`${path}.on is required (event type, array of types, or "*")`);
    }
    on = arr;
  }

  // run vs command/args
  const hasRun = typeof raw.run === "string" && raw.run.length > 0;
  const hasCommand = typeof raw.command === "string" && raw.command.length > 0;
  if (hasRun && hasCommand) {
    throw new ConfigError(`${path}: set either "run" or "command", not both`);
  }
  if (!hasRun && !hasCommand) {
    throw new ConfigError(`${path}: one of "run" (shell string) or "command" is required`);
  }
  let args: string[] = [];
  if (hasCommand) {
    const a = toStringArray(raw.args, `${path}.args`);
    args = a ?? [];
  } else if (raw.args !== undefined) {
    throw new ConfigError(`${path}.args is only valid with "command", not "run"`);
  }

  // when
  const whenRaw = raw.when;
  if (whenRaw !== undefined && !isPlainObject(whenRaw)) {
    throw new ConfigError(`${path}.when must be an object`);
  }
  const w = (whenRaw ?? {}) as Record<string, unknown>;
  const when: WhenFilter = {
    elementType: toStringArray(w.elementType, `${path}.when.elementType`),
    context: toStringArray(w.context, `${path}.when.context`),
    chapterId: toStringArray(w.chapterId, `${path}.when.chapterId`),
    chapterName: toStringArray(w.chapterName, `${path}.when.chapterName`),
    addedByAgent:
      w.addedByAgent === undefined
        ? undefined
        : (() => {
            if (typeof w.addedByAgent !== "boolean") {
              throw new ConfigError(`${path}.when.addedByAgent must be a boolean`);
            }
            return w.addedByAgent;
          })(),
  };

  if (raw.timeout !== undefined && (typeof raw.timeout !== "number" || raw.timeout <= 0)) {
    throw new ConfigError(`${path}.timeout must be a positive number (ms)`);
  }
  if (raw.cwd !== undefined && typeof raw.cwd !== "string") {
    throw new ConfigError(`${path}.cwd must be a string`);
  }

  return {
    id: typeof raw.id === "string" && raw.id.length > 0 ? raw.id : `rule-${index + 1}`,
    on,
    when,
    run: hasRun ? (raw.run as string) : undefined,
    command: hasCommand ? (raw.command as string) : undefined,
    args,
    cwd: raw.cwd as string | undefined,
    timeout: raw.timeout as number | undefined,
    env: validateEnv(raw.env, `${path}.env`),
    concurrency: validateConcurrency(raw.concurrency, on, `${path}.concurrency`),
  };
}

/**
 * Validate a parsed config object and apply defaults. Does not touch the filesystem or
 * environment. `configDir` is injected by the loader.
 */
export function validateConfig(raw: unknown, configDir = process.cwd()): SpecStreamConfig {
  if (!isPlainObject(raw)) throw new ConfigError("Config root must be a JSON object");

  if (typeof raw.endpoint !== "string" || raw.endpoint.length === 0) {
    throw new ConfigError(
      '"endpoint" is required (your prooph board API base URL, e.g. https://flow.prooph-board.com/api)',
    );
  }
  try {
    // eslint-disable-next-line no-new
    new URL(raw.endpoint);
  } catch {
    throw new ConfigError(`"endpoint" must be a valid URL (got "${raw.endpoint}")`);
  }

  const logLevel = (raw.logLevel ?? "info") as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new ConfigError(`"logLevel" must be one of ${LOG_LEVELS.join(", ")}`);
  }

  const maxConcurrent = raw.maxConcurrent ?? 4;
  if (typeof maxConcurrent !== "number" || maxConcurrent < 1) {
    throw new ConfigError('"maxConcurrent" must be a number >= 1');
  }

  const drainTimeout = raw.drainTimeout ?? 30000;
  if (typeof drainTimeout !== "number" || drainTimeout < 0) {
    throw new ConfigError('"drainTimeout" must be a non-negative number (ms)');
  }

  const shell = raw.shell ?? true;
  if (typeof shell !== "boolean") throw new ConfigError('"shell" must be a boolean');

  const transport = (raw.transport ?? "realtime") as "realtime" | "poll";
  if (transport !== "realtime" && transport !== "poll") {
    throw new ConfigError('"transport" must be "realtime" or "poll"');
  }

  if (!Array.isArray(raw.rules)) {
    throw new ConfigError('"rules" must be an array');
  }
  if (raw.rules.length === 0) {
    throw new ConfigError('"rules" must contain at least one rule');
  }
  const rules = raw.rules.map((r, i) => validateRule(r, i));

  // Unique rule ids
  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.id)) throw new ConfigError(`Duplicate rule id "${r.id}"`);
    seen.add(r.id);
  }

  // A run rule with shell=false is invalid (needs a shell to parse the string)
  if (shell === false) {
    for (const r of rules) {
      if (r.run !== undefined) {
        throw new ConfigError(
          `${r.id}: "run" requires shell=true; use "command"+"args" when shell is false`,
        );
      }
    }
  }

  return {
    endpoint: raw.endpoint.replace(/\/+$/, ""),
    logDir: typeof raw.logDir === "string" ? raw.logDir : undefined,
    stateDir: typeof raw.stateDir === "string" ? raw.stateDir : undefined,
    logLevel,
    maxConcurrent,
    drainTimeout,
    shell,
    env: validateEnv(raw.env, "env"),
    rules,
    transport,
    configDir,
  };
}
