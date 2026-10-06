/**
 * CLI argument parser (hand-rolled, no dependency). Pure function for testability.
 */

export type Subcommand = "run" | "start" | "stop" | "status" | "logs" | "init" | "sync-back" | "scenario" | "help" | "version";

export type ScenarioSubcommand = "typecheck" | "run" | "test";

export interface CliOptions {
  command: Subcommand;
  configPath?: string;
  logDir?: string;
  stateDir?: string;
  detach: boolean;
  follow: boolean; // logs -f
  dryRun: boolean;
  verbose: boolean;
  quiet: boolean;
  userMode: boolean;
  force: boolean; // init --force
  /** Base commit for sync-back diff (defaults to HEAD~1). */
  fromCommit?: string;
  // ── scenario subcommand ─────────────────────────────────────────────────
  /** Which scenario operation to run: typecheck | run | test. */
  scenarioSubcommand?: ScenarioSubcommand;
  /** --chapter <id|path>: chapter UUID or path to resolve. */
  chapterRef?: string;
  /** --scenario <id|name>: scenario UUID or name to resolve. */
  scenarioRef?: string;
  /** --all: run/test all scenarios in the chapter. */
  all?: boolean;
  /** --playhead <n>: stop the fold at this step index (scenario run only). */
  playhead?: number;
  /** Parse error message, if any (caller prints and exits non-zero). */
  error?: string;
}

const SUBCOMMANDS = new Set<Subcommand>(["run", "start", "stop", "status", "logs", "init", "sync-back", "scenario"]);
const SCENARIO_SUBCOMMANDS = new Set<ScenarioSubcommand>(["typecheck", "run", "test"]);

const DEFAULTS: CliOptions = {
  command: "run",
  detach: false,
  follow: false,
  dryRun: false,
  verbose: false,
  quiet: false,
  userMode: false,
  force: false,
};

/** Parse argv (without node + script, i.e. process.argv.slice(2)). */
export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { ...DEFAULTS };
  let commandSet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    // Subcommand (first positional)
    if (!arg.startsWith("-") && !commandSet) {
      if (SUBCOMMANDS.has(arg as Subcommand)) {
        opts.command = arg as Subcommand;
        commandSet = true;

        // For "scenario", the very next positional arg is the sub-subcommand.
        if (opts.command === "scenario") {
          const next = argv[i + 1];
          if (next !== undefined && !next.startsWith("-")) {
            if (!SCENARIO_SUBCOMMANDS.has(next as ScenarioSubcommand)) {
              return { ...opts, error: `Unknown scenario subcommand "${next}". Use: typecheck, run, test` };
            }
            opts.scenarioSubcommand = next as ScenarioSubcommand;
            i++;
          } else {
            return { ...opts, error: `"scenario" requires a subcommand: typecheck, run, or test` };
          }
        }
        continue;
      }
      return { ...opts, error: `Unknown command "${arg}"` };
    }

    const needsValue = (name: string): string | undefined => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        opts.error = `${name} requires a value`;
        return undefined;
      }
      i++;
      return next;
    };

    switch (arg) {
      case "-h":
      case "--help":
        return { ...opts, command: "help" };
      case "-V":
      case "--version":
        return { ...opts, command: "version" };
      case "-c":
      case "--config": {
        const v = needsValue(arg);
        if (opts.error) return opts;
        opts.configPath = v;
        break;
      }
      case "--log-dir": {
        const v = needsValue(arg);
        if (opts.error) return opts;
        opts.logDir = v;
        break;
      }
      case "--state-dir": {
        const v = needsValue(arg);
        if (opts.error) return opts;
        opts.stateDir = v;
        break;
      }
      case "--from-commit": {
        const v = needsValue(arg);
        if (opts.error) return opts;
        opts.fromCommit = v;
        break;
      }
      case "--chapter": {
        const v = needsValue(arg);
        if (opts.error) return opts;
        opts.chapterRef = v;
        break;
      }
      case "--scenario": {
        const v = needsValue(arg);
        if (opts.error) return opts;
        opts.scenarioRef = v;
        break;
      }
      case "--playhead": {
        const v = needsValue(arg);
        if (opts.error) return opts;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) {
          return { ...opts, error: `--playhead must be a non-negative integer` };
        }
        opts.playhead = n;
        break;
      }
      case "--all":
        opts.all = true;
        break;
      case "-d":
      case "--detach":
        opts.detach = true;
        break;
      case "-f":
      case "--follow":
        opts.follow = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "-v":
      case "--verbose":
        opts.verbose = true;
        break;
      case "-q":
      case "--quiet":
        opts.quiet = true;
        break;
      case "--user":
        opts.userMode = true;
        break;
      case "--force":
        opts.force = true;
        break;
      default:
        return { ...opts, error: `Unknown option "${arg}"` };
    }
  }

  if (opts.verbose && opts.quiet) {
    return { ...opts, error: "--verbose and --quiet are mutually exclusive" };
  }

  // start implies detach
  if (opts.command === "start") opts.detach = true;

  return opts;
}

export const HELP_TEXT = `spec-stream — stream prooph board changelog events and trigger commands

Usage:
  spec-stream [run] [options]        Run in the foreground (default)
  spec-stream init [--force]         Write a starter config into the current directory
  spec-stream start [options]        Start in the background (detached)
  spec-stream stop [options]         Stop the background process
  spec-stream status [options]       Show running status
  spec-stream logs [-f] [options]    Print (or follow) the combined log
  spec-stream sync-back [options]    Sync local model changes back to prooph board
  spec-stream scenario <sub> [opts]  Run Exploration Mode scenarios from the local model

Scenario subcommands (require localSync to be enabled):
  spec-stream scenario typecheck [--chapter <id|path>] [--scenario <id|name>]
  spec-stream scenario run       --chapter <id|path>  --scenario <id|name>  [--playhead <n>]
  spec-stream scenario test      --chapter <id|path> (--scenario <id|name> | --all)

Options:
  -c, --config <path>        Path to proophboard.spec-stream.json
      --log-dir <path>       Override the log directory
      --state-dir <path>     Override the PID/state directory
      --user                 Use the user/daemon state location (XDG)
  -d, --detach               Run in the background (alias of "start" for "run")
  -f, --follow               Follow the log (with "logs")
      --dry-run              Match & log events but do NOT spawn commands
                             (for sync-back: show operations without executing them)
      --from-commit <sha>    Base commit for sync-back diff (default: HEAD~1)
      --force                Overwrite an existing config (with "init")
      --chapter <id|path>    Chapter UUID or path (scenario commands)
      --scenario <id|name>   Scenario UUID or name (scenario commands)
      --all                  Run/test all scenarios in the chapter
      --playhead <n>         Stop fold at step n (scenario run only)
  -v, --verbose              Debug logging
  -q, --quiet                Warnings and errors only
  -h, --help                 Show this help
  -V, --version              Show version

Environment:
  PROOPHBOARD_API_KEY   Your prooph board API key (required). Never put it in the config.
`;
