/**
 * Shared transpile helper for the scenario runner.
 *
 * Pre-transpiles every authored play function in a chapter from TypeScript to
 * JavaScript (sucrase type-erasure) so the fold can execute them synchronously.
 *
 * Elements that fail to transpile are recorded as errors and their handler falls
 * back to the runtime default — identical to handlerWorker.ts behaviour.
 */

import type { Chapter, RuntimeError, TranspiledHandlers } from "@proophboard/exploration-runtime";
import { transpilePlayFunction } from "@proophboard/exploration-runtime";

export interface TranspileResult {
  handlers: TranspiledHandlers;
  errors: RuntimeError[];
}

/**
 * Transpile all authored play functions in `chapter`.
 *
 * Elements with no play function, or an empty play function, are silently skipped
 * (the fold uses its default handler for them). Transpile failures are collected in
 * `errors`; the element continues with a default handler.
 */
export async function transpileHandlers(chapter: Chapter): Promise<TranspileResult> {
  const handlers: TranspiledHandlers = {};
  const errors: RuntimeError[] = [];

  await Promise.all(
    chapter.elements.map(async (el, stepIndex) => {
      if (!el.playFunction?.trim()) return;
      try {
        handlers[el.id] = await transpilePlayFunction(el.playFunction);
      } catch (err) {
        errors.push({
          kind: "threw",
          message: `Transpile error in "${el.name}": ${(err as Error).message}`,
          stepIndex,
          elementId: el.id,
          elementName: el.name,
        });
      }
    }),
  );

  return { handlers, errors };
}
