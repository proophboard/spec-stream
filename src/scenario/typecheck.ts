/**
 * Typecheck play functions using the TypeScript compiler API.
 *
 * Feeds the same three .d.ts surfaces Monaco uses into an in-memory ts.Program:
 *   1. RUNTIME_AMBIENT_DTS  — static runtime globals (emit, reject, uuid, now, …)
 *   2. buildModelDts(chapter) — per-chapter unions and projection shape
 *   3. buildPerElementDts(element) — pinned interact/decide/apply for this element
 *
 * This catches typo'd command/event names, wrong property access on declared
 * playType, and bad assignments to projection patches — without running anything.
 *
 * TypeScript is a peer / dev dependency; if it's absent a clear error is surfaced.
 */

import type { Chapter, Element } from "@proophboard/exploration-runtime";
import {
  RUNTIME_AMBIENT_DTS,
  buildModelDts,
  buildPerElementDts,
  wrapPlayType,
  parsePlayType,
} from "@proophboard/exploration-runtime";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface PlayFunctionDiagnostic {
  elementId: string;
  elementName: string;
  elementType: string;
  kind: "play-function" | "play-type";
  /** 1-based line number within the source file. */
  line: number;
  col: number;
  /** TypeScript error code (e.g. 2339). */
  code: number;
  message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Typecheck all elements in `chapter` that have a `playFunction` or `playType`.
 * Returns diagnostics for every element that has issues.
 */
export async function typecheckChapter(
  chapter: Chapter,
): Promise<PlayFunctionDiagnostic[]> {
  const ts = await loadTs();
  if (!ts) {
    throw new Error(
      "TypeScript is not installed. Add 'typescript' to your devDependencies to use the typecheck command.",
    );
  }

  const diagnostics: PlayFunctionDiagnostic[] = [];
  for (const element of chapter.elements) {
    if (!element.playFunction?.trim() && !element.playType?.trim()) continue;
    const elDiags = typecheckElement(ts, chapter, element);
    diagnostics.push(...elDiags);
  }
  return diagnostics;
}

/**
 * Typecheck a single element synchronously (requires a pre-loaded `ts` module).
 * Use `typecheckChapter` for the async public API.
 */
export function typecheckElement(
  // ts is typed as unknown to avoid importing typescript as a type dep here
  ts: TsModule,
  chapter: Chapter,
  element: Element,
): PlayFunctionDiagnostic[] {
  const results: PlayFunctionDiagnostic[] = [];

  const ambientDts = RUNTIME_AMBIENT_DTS;
  const modelDts = buildModelDts(chapter);
  const elementDts = buildPerElementDts(element);

  const compilerOptions: object = {
    target: /* ES2020 */ 7,
    lib: ["lib.es2020.d.ts"],
    noEmit: true,
    allowNonTsExtensions: true,
    moduleResolution: /* NodeJs */ 2,
    strict: false,
    noImplicitAny: false,
    skipLibCheck: true,
  };

  // ── play-function.ts ──────────────────────────────────────────────────────
  if (element.playFunction?.trim()) {
    const handlerFile = "handler.ts";
    const virtualFiles: Record<string, string> = {
      "exploration-runtime.d.ts": ambientDts,
      "exploration-model.d.ts": modelDts,
      "exploration-element.d.ts": elementDts,
      [handlerFile]: element.playFunction,
    };

    const diags = runInMemoryTypecheck(ts, virtualFiles, handlerFile, compilerOptions);
    for (const d of diags) {
      results.push({
        elementId: element.id,
        elementName: element.name,
        elementType: element.type,
        kind: "play-function",
        line: d.line,
        col: d.col,
        code: d.code,
        message: d.message,
      });
    }
  }

  // ── play-type.ts ──────────────────────────────────────────────────────────
  if (element.playType?.trim()) {
    // playType is the bare expression; wrap it as Monaco does.
    const wrapped = wrapPlayType(element.playType);
    const parseResult = parsePlayType(wrapped);
    if (!parseResult.ok) {
      results.push({
        elementId: element.id,
        elementName: element.name,
        elementType: element.type,
        kind: "play-type",
        line: 1,
        col: 1,
        code: 9999,
        message: `play-type parse error: ${parseResult.error}`,
      });
    } else {
      const playTypeFile = "play-type.ts";
      const virtualFiles: Record<string, string> = {
        "exploration-runtime.d.ts": ambientDts,
        [playTypeFile]: wrapped,
      };
      const diags = runInMemoryTypecheck(ts, virtualFiles, playTypeFile, compilerOptions);
      for (const d of diags) {
        results.push({
          elementId: element.id,
          elementName: element.name,
          elementType: element.type,
          kind: "play-type",
          line: d.line,
          col: d.col,
          code: d.code,
          message: d.message,
        });
      }
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

interface RawDiagnostic {
  line: number;
  col: number;
  code: number;
  message: string;
}

// Minimal TypeScript API surface we need (avoids importing ts as a type dep).
interface TsModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createProgram(rootNames: string[], options: object, host?: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createCompilerHost(options: object): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  flattenDiagnosticMessageText(msg: any, newline: string): string;
}

function runInMemoryTypecheck(
  ts: TsModule,
  virtualFiles: Record<string, string>,
  targetFile: string,
  compilerOptions: object,
): RawDiagnostic[] {
  const host = ts.createCompilerHost(compilerOptions);
  const origGetSourceFile = host.getSourceFile.bind(host);

  host.getSourceFile = (
    fileName: string,
    languageVersion: unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...rest: any[]
  ) => {
    if (Object.prototype.hasOwnProperty.call(virtualFiles, fileName)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (ts as any).createSourceFile(
        fileName,
        virtualFiles[fileName],
        languageVersion,
        true,
      );
    }
    return origGetSourceFile(fileName, languageVersion, ...rest);
  };

  host.fileExists = (f: string) =>
    Object.prototype.hasOwnProperty.call(virtualFiles, f) || false;
  host.readFile = (f: string) => virtualFiles[f];

  const program = ts.createProgram(Object.keys(virtualFiles), compilerOptions, host);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sourceFile = (program as any).getSourceFile(targetFile);
  if (!sourceFile) return [];

  const syntactic = program.getSyntacticDiagnostics(sourceFile);
  const semantic = program.getSemanticDiagnostics(sourceFile);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return [...syntactic, ...semantic].map((d: any) => {
    let line = 1;
    let col = 1;
    if (d.file && d.start !== undefined) {
      const lc = d.file.getLineAndCharacterOfPosition(d.start);
      line = lc.line + 1;
      col = lc.character + 1;
    }
    return {
      line,
      col,
      code: d.code as number,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    };
  });
}

async function loadTs(): Promise<TsModule | null> {
  try {
    // Dynamic import — ts is optional at runtime.
    const ts = await import("typescript");
    return ts as unknown as TsModule;
  } catch {
    return null;
  }
}
