/**
 * Generate workspace-wide model.d.ts for TypeScript IDE support.
 *
 * This file generates a single `model.d.ts` at the root of the local sync directory
 * that aggregates all chapters' type definitions. This allows the IDE to provide
 * autocomplete and type checking for play functions across the entire workspace.
 *
 * The generated file uses TypeScript's declaration merging to combine types from
 * all chapters:
 *   - CommandName: union of all command names across all chapters
 *   - EventName: union of all event names across all chapters
 *   - ContextName: union of all contexts across all chapters
 *   - RuntimeState: merged projection keys from all chapters
 *   - Payload interfaces: merged from all chapters' declared playTypes
 *
 * File path: `.spec-stream/model.d.ts`
 */

import type { Element } from "@proophboard/exploration-runtime";
import type { ModelState } from "./model.js";
import { slicesOfChapter, lanesOfChapter, elementsInCell } from "./model.js";
import lodash from "lodash";
const { camelCase, startCase } = lodash;

/**
 * toClassName — the single shared element/context key algorithm.
 * 
 * Canonical algorithm (matches eventflow-designer `names().className`):
 *   startCase(camelCase(str)).replace(/ /g, '')
 */
function toClassName(name: string): string {
  return startCase(camelCase(name)).replace(/ /g, '');
}

/**
 * Build a workspace-wide model.d.ts by aggregating types from all chapters.
 * 
 * This function collects all commands, events, and information elements across
 * all chapters and merges their type definitions into a single declaration file.
 * This allows play functions to reference types from any chapter in the workspace.
 * 
 * The approach:
 *   - For unions (CommandName, EventName, ContextName): merge all chapter unions
 *   - For interfaces (CommandPayloads, EventPayloads, etc.): merge all interfaces
 *   - For RuntimeState: merge all projection keys from all chapters
 * 
 * Returns a string in the same format as buildModelDts from @proophboard/exploration-runtime,
 * suitable for writing to `.spec-stream/model.d.ts`.
 */
export function buildWorkspaceModelDts(state: ModelState): string {
  // Collect all elements across all chapters
  const allElements: Element[] = [];
  
  for (const chapterState of state.chapters.values()) {
    const slices = slicesOfChapter(state, chapterState.id);
    const lanes = lanesOfChapter(state, chapterState.id);
    
    for (const lane of lanes) {
      for (const slice of slices) {
        for (const element of elementsInCell(state, lane.id, slice.id)) {
          // Cast to Element type
          allElements.push({
            id: element.id,
            type: element.type as Element["type"],
            name: element.name,
            context: element.context,
            laneId: element.laneId,
            sliceId: element.sliceId,
            index: element.index,
            icon: element.icon,
            noArrowSource: element.noArrowSource,
            noArrowTarget: element.noArrowTarget,
            playFunction: element.playFunction,
            playType: element.playType,
          });
        }
      }
    }
  }
  
  if (allElements.length === 0) {
    // No elements - return minimal valid types
    return `declare global {
  /** Command names in this workspace (none yet). */
  type CommandName = string;
  /** Event names in this workspace (none yet). */
  type EventName = string;
  /** Contexts in this workspace (none yet). */
  type ContextName = string;
  /** Declared command payloads (none yet). */
  interface CommandPayloads {}
  /** Declared event payloads (none yet). */
  interface EventPayloads {}
  /** Declared UI input shapes (none yet). */
  interface UiInputs {}
  /** The return shape of \`apply\` (none modeled yet — any object). */
  type ProjectionPatch = Record<string, Record<string, unknown>>;
}
export {};
`;
  }
  
  // Build merged types
  const commandNames = collectNames(allElements, "command");
  const eventNames = collectNames(allElements, "event");
  const contextNames = collectContexts(allElements);
  
  // Collect payloads by element type
  const commandPayloads = collectPayloads(allElements, "command");
  const eventPayloads = collectPayloads(allElements, "event");
  const uiInputs = collectPayloads(allElements, "ui");
  
  // Collect projection shapes from information elements
  const projectionShapes = collectProjectionShapes(allElements);
  
  return buildMergedDts(
    commandNames,
    eventNames,
    contextNames,
    commandPayloads,
    eventPayloads,
    uiInputs,
    projectionShapes,
  );
}

/**
 * Collect all distinct names for a given element type.
 */
function collectNames(elements: Element[], type: Element["type"]): string[] {
  const names = new Set<string>();
  for (const el of elements) {
    if (el.type === type && el.name.trim()) {
      names.add(el.name.trim());
    }
  }
  return [...names].sort();
}

/**
 * Collect all distinct contexts across all elements.
 */
function collectContexts(elements: Element[]): string[] {
  const contexts = new Set<string>();
  for (const el of elements) {
    if (el.context.trim()) {
      contexts.add(el.context.trim());
    }
  }
  return [...contexts].sort();
}

/**
 * Collect playType payloads for a given element type.
 * Returns a Map where keys are element names and values are type expressions.
 */
function collectPayloads(elements: Element[], type: Element["type"]): Map<string, string> {
  const payloads = new Map<string, string>();
  for (const el of elements) {
    if (el.type === type && el.name.trim() && el.playType?.trim()) {
      payloads.set(el.name.trim(), el.playType.trim());
    }
  }
  return payloads;
}

/**
 * Collect projection shapes from information elements.
 * Returns a Map where keys are context class names and values are Maps of element class names to types.
 */
function collectProjectionShapes(elements: Element[]): Map<string, Map<string, string | null>> {
  const shapes = new Map<string, Map<string, string | null>>();
  
  for (const el of elements) {
    if (el.type === "information" && el.context.trim() && el.name.trim()) {
      const ctxKey = toClassName(el.context.trim());
      const elKey = toClassName(el.name.trim());
      
      if (ctxKey && elKey) {
        let contextMap = shapes.get(ctxKey);
        if (!contextMap) {
          contextMap = new Map<string, string | null>();
          shapes.set(ctxKey, contextMap);
        }
        contextMap.set(elKey, el.playType?.trim() ?? null);
      }
    }
  }
  
  return shapes;
}

/**
 * Build the merged dts file content from collected types.
 */
function buildMergedDts(
  commandNames: string[],
  eventNames: string[],
  contextNames: string[],
  commandPayloads: Map<string, string>,
  eventPayloads: Map<string, string>,
  uiInputs: Map<string, string>,
  projectionShapes: Map<string, Map<string, string | null>>,
): string {
  // Build union strings
  const commandNameUnion = buildUnion(commandNames);
  const eventNameUnion = buildUnion(eventNames);
  const contextNameUnion = buildUnion(contextNames);
  
  // Build payload interfaces
  const commandPayloadsInterface = buildPayloadInterface("CommandPayloads", commandPayloads, "Declard command payloads, keyed by command name. Narrows RuntimeCommand.payload on `.name`.");
  const eventPayloadsInterface = buildPayloadInterface("EventPayloads", eventPayloads, "Declard event payloads, keyed by event name. Narrows RuntimeEvent(Input).payload on `.name`.");
  const uiInputsInterface = buildPayloadInterface("UiInputs", uiInputs, "Declard UI input shapes, keyed by UI element name. Pins interact's `storage` per element.");
  
  // Build projection patch
  const projectionPatch = buildProjectionPatch(projectionShapes);
  
  // Build RuntimeState augmentation
  const runtimeState = buildRuntimeState(projectionShapes);
  
  return `declare global {
  /** Command names across all chapters in this workspace. */
  type CommandName = ${commandNameUnion};

  /** Event names across all chapters in this workspace. */
  type EventName = ${eventNameUnion};

  /** Contexts across all chapters in this workspace. */
  type ContextName = ${contextNameUnion};

${commandPayloadsInterface}
${eventPayloadsInterface}
${uiInputsInterface}
${projectionPatch}
${runtimeState}}export {};
`;
}

/**
 * Build a TypeScript union type from an array of strings.
 * Returns "string" if the array is empty, or a union like "A" | "B" | "C".
 */
function buildUnion(items: string[]): string {
  if (items.length === 0) {
    return "string";
  }
  return items.map(item => JSON.stringify(item)).join(" | ");
}

/**
 * Build a payload interface from a map of element names to playType expressions.
 */
function buildPayloadInterface(
  name: string,
  payloads: Map<string, string>,
  doc: string,
): string {
  if (payloads.size === 0) {
    return `  /** ${doc.replace(/Declard/, "Declared")} (none yet). */\n  interface ${name} {}`;
  }
  
  // Sort by name for stable output
  const sortedEntries = [...payloads.entries()].sort(([a], [b]) => a.localeCompare(b));
  
  const members = sortedEntries.map(([name, type]) => {
    return `    ${JSON.stringify(name)}: ${type};`;
  });
  
  return `  /** ${doc.replace(/Declard/, "Declared")} */\n  interface ${name} {\n${members.join("\n")}\n  }`;
}

/**
 * Build the ProjectionPatch interface from merged projection shapes.
 */
function buildProjectionPatch(
  shapes: Map<string, Map<string, string | null>>,
): string {
  if (shapes.size === 0) {
    return `  /** The return shape of \`apply\` (no Information modeled yet — any object). */
  type ProjectionPatch = Record<string, Record<string, unknown>>;
`;
  }
  
  const contextMembers: string[] = [];
  const sortedContexts = [...shapes.keys()].sort();
  
  for (const ctxKey of sortedContexts) {
    const elements = shapes.get(ctxKey)!;
    const elementEntries: string[] = [];
    
    const sortedElements = [...elements.keys()].sort();
    for (const elKey of sortedElements) {
      const type = elements.get(elKey)! ?? "unknown";
      elementEntries.push(`    ${elKey}?: Partial<${type}>;`);
    }
    
    contextMembers.push(`  ${ctxKey}?: {\n${elementEntries.join("\n")}\n  };`);
  }
  
  return `  /**
   * The return shape of \`apply\`. Known contexts/elements are checked — a typo'd
   * context or Information name is flagged. Every key is optional (write a subset).
   */
  interface ProjectionPatch {
${contextMembers.join("\n")}
  }
`;
}

/**
 * Build the RuntimeState augmentation from merged projection shapes.
 */
function buildRuntimeState(
  shapes: Map<string, Map<string, string | null>>,
): string {
  if (shapes.size === 0) {
    return "";
  }
  
  const interfaceMembers: string[] = [];
  const sortedContexts = [...shapes.keys()].sort();
  
  for (const ctxKey of sortedContexts) {
    const elements = shapes.get(ctxKey)!;
    const elementEntries: string[] = [];
    
    const sortedElements = [...elements.keys()].sort();
    for (const elKey of sortedElements) {
      const type = elements.get(elKey)! ?? "any";
      const shape = elements.get(elKey)!;
      elementEntries.push(`    /** Projection: state.${ctxKey}.${elKey} (${shape ? "declared shape" : "object, list, or scalar"}) */\n    ${elKey}: ${type};`);
    }
    
    interfaceMembers.push(`  /** Context "${ctxKey}" projections. */\n  ${ctxKey}: {\n${elementEntries.join("\n")}\n    [element: string]: any;\n  };`);
  }
  
  // Build namespace (for dotted path access)
  const namespaceParts: string[] = [];
  for (const ctxKey of sortedContexts) {
    const elements = shapes.get(ctxKey)!;
    const elementEntries: string[] = [];
    
    const sortedElements = [...elements.keys()].sort();
    for (const elKey of sortedElements) {
      const type = elements.get(elKey)! ?? "any";
      elementEntries.push(`      type ${elKey} = ${type};`);
    }
    
    namespaceParts.push(`    namespace ${ctxKey} {\n${elementEntries.join("\n")}\n    }`);
  }
  
  return `  /**
   * Model-derived projection keys (from all chapters' Information elements).
   * Merges with the base RuntimeState: known contexts/elements autocomplete,
   * unknown keys still resolve to \`any\` via the base index signature. Where an
   * Information element declares a payload type, its projection is strictly typed.
   */
  interface RuntimeState {
${interfaceMembers.join("\n")}
  }

  /**
   * Namespace mirror of RuntimeState projections. Allows dotted-path type
   * references in the Type editor:  type Payload = RuntimeState.TodoManagement.Todo
   */
  namespace RuntimeState {
${namespaceParts.join("\n")}
  }
`;
}