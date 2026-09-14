/**
 * CLI argument parser (hand-rolled, no dependency). Pure function for testability.
 */

export type Subcommand = "run" | "start" | "stop" | "status" | "logs" | "help" | "version";

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
  /** Parse error message, if any (caller prints and exits non-zero). */
  error?: string;
}

const SUBCOMMANDS = new Set<Subcommand>(["run", "start", "stop", "status", "logs"]);

const DEFAULTS: CliOptions = {
  command: "run",
  detach: false,
  follow: false,
  dryRun: false,
  verbose: false,
  quiet: false,
  userMode: false,
};

/** Parse argv (without node + script, i.e. process.argv.slice(2)). */
export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { ...DEFAULTS };
  let commandSet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    // Subcommand (first positional)
    if (!arg.startsWith("-") && !commandSet) {
      if (SUBCOMMANDS.has(arg as Subcommand)) {
        opts.command = arg as Subcommand;
        commandSet = true;
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
  spec-stream [run] [options]      Run in the foreground (default)
  spec-stream start [options]      Start in the background (detached)
  spec-stream stop [options]       Stop the background process
  spec-stream status [options]     Show running status
  spec-stream logs [-f] [options]  Print (or follow) the combined log

Options:
  -c, --config <path>   Path to proophboard.spec-stream.json
      --log-dir <path>  Override the log directory
      --state-dir <path>Override the PID/state directory
      --user            Use the user/daemon state location (XDG)
  -d, --detach          Run in the background (alias of "start" for "run")
  -f, --follow          Follow the log (with "logs")
      --dry-run         Match & log events but do NOT spawn commands
  -v, --verbose         Debug logging
  -q, --quiet           Warnings and errors only
  -h, --help            Show this help
  -V, --version         Show version

Environment:
  PROOPHBOARD_API_KEY   Your prooph board API key (required). Never put it in the config.
`;
