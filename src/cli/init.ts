/**
 * `spec-stream init` — scaffold a starter config in the project root.
 *
 * Writes `proophboard.spec-stream.json` into the current working directory with a
 * commented, ready-to-edit example rule that runs a harmless `echo` command. Refuses to
 * overwrite an existing config unless `force` is set.
 *
 * The file writer and existence check are injectable so this is unit-testable without
 * touching the real filesystem.
 */

import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILENAME } from "../config/load.js";

/** The starter config written by `init`. Kept as a string so comments/formatting are exact. */
export const STARTER_CONFIG = `{
  "endpoint": "https://flow.prooph-board.com/api",
  "logLevel": "info",
  "rules": [
    {
      "id": "example",
      "on": "element-description-changed",
      "run": "echo \\"[$SPEC_STREAM_RULE_ID] $SPEC_STREAM_EVENT_TYPE on $SPEC_STREAM_ELEMENT_NAME\\""
    }
  ]
}
`;

export interface InitOptions {
  /** Directory to write the config into (default: process.cwd()). */
  cwd?: string;
  /** Overwrite an existing config file. */
  force?: boolean;
  /** Injectable existence check (testing). */
  fileExists?: (p: string) => boolean;
  /** Injectable writer (testing). */
  writeFile?: (p: string, contents: string) => void;
}

export interface InitResult {
  /** Absolute path of the config that was (or would be) written. */
  path: string;
  /** True if the file was written; false if it already existed and force was not set. */
  written: boolean;
}

/**
 * Perform the init. Returns the target path and whether a file was written.
 * @throws {Error} only if the injected writer throws.
 */
export function runInit(options: InitOptions = {}): InitResult {
  const {
    cwd = process.cwd(),
    force = false,
    fileExists = existsSync,
    writeFile = (p: string, contents: string) => writeFileSync(p, contents, "utf8"),
  } = options;

  const path = join(cwd, CONFIG_FILENAME);

  if (fileExists(path) && !force) {
    return { path, written: false };
  }

  writeFile(path, STARTER_CONFIG);
  return { path, written: true };
}
