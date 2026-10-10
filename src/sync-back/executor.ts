/**
 * API executor for the sync-back command.
 *
 * Takes an ordered list of {@link SyncBackOperation}s and executes them against the
 * prooph board REST API using the {@link RestClient}. Supports `--dry-run` mode where
 * operations are logged but not executed.
 *
 * Operations are executed sequentially (not in parallel) to respect the dependency
 * ordering established by the operation builder.
 */

import type { RestClient } from "../sync/restClient.js";
import type { SyncBackOperation } from "./operationBuilder.js";

export interface ExecuteOptions {
  /** When true, log operations but don't call the API. */
  dryRun: boolean;
  /** Logger function for output. */
  log: (msg: string) => void;
}

export interface ExecuteResult {
  executed: number;
  skipped: number;
  failed: number;
  errors: Array<{ operation: SyncBackOperation; error: string }>;
  /**
   * Map of entityDir → new API id for each successfully executed create operation.
   * Used by sync-back to write sync-back-ids.json so the next run can distinguish
   * creates from updates without needing the sync process to have caught up yet.
   *
   * Key: the entityDir as passed in the operation (chapters/…, milestones/…, etc.)
   * Value: the UUID returned by the prooph board API.
   */
  newIds: Map<string, string>;
}

/**
 * Execute sync-back operations against the prooph board REST API.
 *
 * Sequential execution respects the dependency order (creates before updates).
 * On failure, the operation is logged and execution continues with the next operation
 * (fail-forward) so that a single bad entity doesn't block everything else.
 */
export async function executeOperations(
  client: RestClient,
  operations: SyncBackOperation[],
  opts: ExecuteOptions,
): Promise<ExecuteResult> {
  const result: ExecuteResult = { executed: 0, skipped: 0, failed: 0, errors: [], newIds: new Map() };

  for (const op of operations) {
    const label = describeOperation(op);
    if (opts.dryRun) {
      opts.log(`[dry-run] ${label}`);
      result.skipped++;
      continue;
    }
    try {
      const newId = await executeOne(client, op);
      opts.log(`✓ ${label}`);
      result.executed++;
      // Capture new id for create operations so syncBack can persist it.
      if (newId !== undefined) {
        const entityDir = entityDirForCreateOp(op);
        if (entityDir) result.newIds.set(entityDir, newId);
      }
    } catch (err) {
      const msg = (err as Error).message;
      opts.log(`✗ ${label}: ${msg}`);
      result.failed++;
      result.errors.push({ operation: op, error: msg });
    }
  }

  return result;
}

async function executeOne(client: RestClient, op: SyncBackOperation): Promise<string | undefined> {
  const enc = encodeURIComponent;

  switch (op.kind) {
    // ─── Chapter ───────────────────────────────────────────────────────────
    case "chapter.create": {
      const res = await client.postJson(`/chapters`, {
        name: op.name,
        ...(op.context !== undefined && { context: op.context }),
        ...(op.mode !== undefined && { mode: op.mode }),
      }) as { chapterId?: string; id?: string } | undefined;
      // The API returns `chapterId` (not `id`) for chapter creates.
      return (res as { chapterId?: string })?.chapterId ?? res?.id;
    }

    case "chapter.rename":
      await client.postJson(`/chapters/${enc(op.chapterId)}/rename`, { new_name: op.newName });
      return undefined;

    case "chapter.update-context":
      await client.patchJson(`/chapters/${enc(op.chapterId)}`, { new_context: op.newContext });
      return undefined;

    case "chapter.delete":
      await client.deleteReq(`/chapters/${enc(op.chapterId)}`);
      return undefined;

    // ─── Lane ─────────────────────────────────────────────────────────────
    case "lane.create": {
      const res = await client.postJson(`/chapters/${enc(op.chapterId)}/lanes`, {
        label: op.label,
        type: op.type,
        index: op.index,
        ...(op.height !== undefined && { height: op.height }),
      }) as { id?: string } | undefined;
      return res?.id;
    }

    case "lane.rename":
      await client.postJson(`/chapters/${enc(op.chapterId)}/lanes/${enc(op.laneId)}/rename`, {
        lane_id: op.laneId,
        new_label: op.newLabel,
      });
      return undefined;

    case "lane.update-details":
      await client.postJson(`/chapters/${enc(op.chapterId)}/lanes/${enc(op.laneId)}/details`, {
        lane_id: op.laneId,
        new_details: op.newDetails,
      });
      return undefined;

    case "lane.resize":
      await client.postJson(`/chapters/${enc(op.chapterId)}/lanes/${enc(op.laneId)}/resize`, {
        lane_id: op.laneId,
        new_height: op.newHeight,
      });
      return undefined;

    case "lane.delete":
      await client.deleteReq(`/chapters/${enc(op.chapterId)}/lanes/${enc(op.laneId)}`);
      return undefined;

    // ─── Slice ────────────────────────────────────────────────────────────
    case "slice.create": {
      const res = await client.postJson(`/chapters/${enc(op.chapterId)}/slices`, {
        label: op.label,
        ...(op.index !== undefined && { index: op.index }),
        ...(op.status !== undefined && { status: op.status }),
        ...(op.details !== undefined && { details: op.details }),
        ...(op.width !== undefined && { width: op.width }),
      }) as { id?: string } | undefined;
      return res?.id;
    }

    case "slice.rename":
      await client.postJson(`/chapters/${enc(op.chapterId)}/slices/${enc(op.sliceId)}/rename`, {
        slice_id: op.sliceId,
        new_label: op.newLabel,
      });
      return undefined;

    case "slice.update-details":
      await client.postJson(`/chapters/${enc(op.chapterId)}/slices/${enc(op.sliceId)}/details`, {
        slice_id: op.sliceId,
        new_details: op.newDetails,
      });
      return undefined;

    case "slice.update-status":
      await client.postJson(`/chapters/${enc(op.chapterId)}/slices/${enc(op.sliceId)}/status`, {
        slice_id: op.sliceId,
        new_status: op.newStatus,
      });
      return undefined;

    case "slice.delete":
      await client.deleteReq(`/chapters/${enc(op.chapterId)}/slices/${enc(op.sliceId)}`);
      return undefined;

    // ─── Element ──────────────────────────────────────────────────────────
    case "element.create": {
      const res = await client.postJson(`/chapters/${enc(op.chapterId)}/elements`, {
        name: op.name,
        type: op.type,
        lane_id: op.laneId,
        slice_id: op.sliceId,
        ...(op.description !== undefined && { description: op.description }),
        ...(op.details !== undefined && { details: op.details }),
        ...(op.index !== undefined && { index: op.index }),
        ...(op.context !== undefined && { context: op.context }),
      }) as { id?: string } | undefined;
      return res?.id;
    }

    case "element.rename":
      await client.postJson(`/chapters/${enc(op.chapterId)}/elements/${enc(op.elementId)}/rename`, {
        new_name: op.newName,
      });
      return undefined;

    case "element.update-description":
      await client.postJson(`/chapters/${enc(op.chapterId)}/elements/${enc(op.elementId)}/description`, {
        new_description: op.newDescription,
      });
      return undefined;

    case "element.update-details":
      await client.postJson(`/chapters/${enc(op.chapterId)}/elements/${enc(op.elementId)}/details`, {
        new_details: op.newDetails,
      });
      return undefined;

    case "element.update-config":
      await client.postJson(`/chapters/${enc(op.chapterId)}/elements/${enc(op.elementId)}/config`, {
        ...(op.playFunction !== undefined && { play_function: op.playFunction }),
        ...(op.playType !== undefined && { play_type: op.playType }),
      });
      return undefined;

    case "element.move":
      await client.postJson(`/chapters/${enc(op.chapterId)}/elements/${enc(op.elementId)}/move`, {
        element_id: op.elementId,
        new_lane_id: op.newLaneId,
        new_slice_id: op.newSliceId,
        new_index: op.newIndex,
      });
      return undefined;

    case "element.delete":
      await client.deleteReq(`/chapters/${enc(op.chapterId)}/elements/${enc(op.elementId)}`);
      return undefined;

    // ─── Milestone ────────────────────────────────────────────────────────
    case "milestone.create": {
      const res = await client.postJson(`/milestones`, {
        name: op.name,
        ...(op.description !== undefined && { description: op.description }),
        ...(op.deadline !== undefined && { deadline: op.deadline }),
        ...(op.color !== undefined && { color: op.color }),
      }) as { id?: string } | undefined;
      return res?.id;
    }

    case "milestone.update":
      await client.patchJson(`/milestones/${enc(op.milestoneId)}`, {
        ...(op.name !== undefined && { name: op.name }),
        ...(op.description !== undefined && { description: op.description }),
        ...(op.deadline !== undefined && { deadline: op.deadline }),
        ...(op.color !== undefined && { color: op.color }),
      });
      return undefined;

    case "milestone.delete":
      await client.deleteReq(`/milestones/${enc(op.milestoneId)}`);
      return undefined;

    // ─── HTML Snippet ─────────────────────────────────────────────────────
    case "html-snippet.create": {
      const res = await client.postJson(`/snippets`, {
        name: op.name,
        snippet: op.snippet,
        ...(op.slug !== undefined && { slug: op.slug }),
      }) as { slug?: string } | undefined;
      return res?.slug;
    }

    case "html-snippet.update":
      await client.patchJson(`/snippets/${enc(op.slug)}`, {
        ...(op.name !== undefined && { name: op.name }),
        ...(op.snippet !== undefined && { snippet: op.snippet }),
      });
      return undefined;

    case "html-snippet.delete":
      await client.deleteReq(`/snippets/${enc(op.slug)}`);
      return undefined;

    // ─── Scenario CRUD + interactions ────────────────────────────────────
    case "scenario.create": {
      const res = await client.postJson(
        `/chapters/${enc(op.chapterId)}/scenarios`,
        {
          name: op.name,
          ...(op.clock !== undefined && { clock: op.clock }),
          ...(op.initialState !== undefined && { initial_state: op.initialState }),
          ...(op.seededEvents !== undefined && { seeded_events: op.seededEvents }),
        },
      ) as { id?: string } | undefined;
      return res?.id;
    }

    case "scenario.delete":
      await client.deleteReq(`/chapters/${enc(op.chapterId)}/scenarios/${enc(op.scenarioId)}`);
      return undefined;

    case "scenario.update":
      await client.patchJson(
        `/chapters/${enc(op.chapterId)}/scenarios/${enc(op.scenarioId)}`,
        {
          ...(op.name !== undefined && { name: op.name }),
          ...(op.clock !== undefined && { clock: op.clock }),
          ...(op.initialState !== undefined && { initial_state: op.initialState }),
          ...(op.seededEvents !== undefined && { seeded_events: op.seededEvents }),
        },
      );
      return undefined;

    case "scenario.record-interaction":
      await client.postJson(
        `/chapters/${enc(op.chapterId)}/scenarios/${enc(op.scenarioId)}/interactions`,
        { step_index: op.stepIndex, storage: op.storage },
      );
      return undefined;

    case "scenario.clear-interactions":
      await client.deleteReq(
        `/chapters/${enc(op.chapterId)}/scenarios/${enc(op.scenarioId)}/interactions`,
      );
      return undefined;

    // ─── Scenario expectations ────────────────────────────────────────────
    case "scenario.set-expectation":
      await client.postJson(
        `/chapters/${enc(op.chapterId)}/scenarios/${enc(op.scenarioId)}/expectations`,
        {
          expectation_id: op.expectation.id,
          slice_id: op.expectation.sliceId,
          kind: op.expectation.kind,
          expected: op.expectation.expected,
          ...(op.expectation.elementId !== undefined && { element_id: op.expectation.elementId }),
          ...(op.expectation.match !== undefined && { match: op.expectation.match }),
        },
      );
      return undefined;

    case "scenario.remove-expectation":
      await client.deleteReq(
        `/chapters/${enc(op.chapterId)}/scenarios/${enc(op.scenarioId)}/expectations/${enc(op.expectationId)}`,
      );
      return undefined;

    default:
      throw new Error(`Unknown operation kind: ${(op as SyncBackOperation).kind}`);
  }
}

/**
 * Return the entityDir carried on a create operation (set by operationBuilder).
 * Returns undefined for non-create operations or creates without an entityDir.
 */
function entityDirForCreateOp(op: SyncBackOperation): string | undefined {
  if (
    op.kind === "chapter.create" ||
    op.kind === "lane.create" ||
    op.kind === "slice.create" ||
    op.kind === "element.create" ||
    op.kind === "milestone.create" ||
    op.kind === "html-snippet.create" ||
    op.kind === "scenario.create"
  ) {
    return op.entityDir;
  }
  return undefined;
}

/** Human-readable description of an operation for logging. */
function describeOperation(op: SyncBackOperation): string {
  switch (op.kind) {
    case "chapter.create":          return `Create chapter "${op.name}"`;
    case "chapter.rename":          return `Rename chapter ${op.chapterId} → "${op.newName}"`;
    case "chapter.update-context":  return `Update chapter ${op.chapterId} context → "${op.newContext}"`;
    case "chapter.delete":          return `Delete chapter ${op.chapterId}`;
    case "lane.create":             return `Create lane "${op.label}" (${op.type}) in chapter ${op.chapterId}`;
    case "lane.rename":             return `Rename lane ${op.laneId} → "${op.newLabel}"`;
    case "lane.update-details":     return `Update lane ${op.laneId} details`;
    case "lane.resize":             return `Resize lane ${op.laneId} → ${op.newHeight}px`;
    case "lane.delete":             return `Delete lane ${op.laneId}`;
    case "slice.create":            return `Create slice "${op.label}" in chapter ${op.chapterId}`;
    case "slice.rename":            return `Rename slice ${op.sliceId} → "${op.newLabel}"`;
    case "slice.update-details":    return `Update slice ${op.sliceId} details`;
    case "slice.update-status":     return `Update slice ${op.sliceId} status → "${op.newStatus}"`;
    case "slice.delete":            return `Delete slice ${op.sliceId}`;
    case "element.create":          return `Create element "${op.name}" (${op.type}) in chapter ${op.chapterId}`;
    case "element.rename":          return `Rename element ${op.elementId} → "${op.newName}"`;
    case "element.update-description": return `Update element ${op.elementId} description`;
    case "element.update-details":  return `Update element ${op.elementId} details`;
    case "element.update-config":   return `Update element ${op.elementId} play config`;
    case "element.move":            return `Move element ${op.elementId} to lane ${op.newLaneId} / slice ${op.newSliceId}`;
    case "element.delete":          return `Delete element ${op.elementId}`;
    case "milestone.create":        return `Create milestone "${op.name}"`;
    case "milestone.update":        return `Update milestone ${op.milestoneId}`;
    case "milestone.delete":        return `Delete milestone ${op.milestoneId}`;
    case "html-snippet.create":     return `Create HTML snippet "${op.name}" (slug: ${op.slug ?? "auto"})`;
    case "html-snippet.update":     return `Update HTML snippet "${op.slug}"`;
    case "html-snippet.delete":     return `Delete HTML snippet "${op.slug}"`;
    case "scenario.set-expectation":    return `Set expectation ${op.expectation.id} (${op.expectation.kind}) on scenario ${op.scenarioId}`;
    case "scenario.remove-expectation": return `Remove expectation ${op.expectationId} from scenario ${op.scenarioId}`;
    case "scenario.create":             return `Create scenario "${op.name}" in chapter ${op.chapterId}`;
    case "scenario.delete":             return `Delete scenario ${op.scenarioId}`;
    case "scenario.update":             return `Update scenario ${op.scenarioId}`;
    case "scenario.record-interaction": return `Record interaction step ${op.stepIndex} on scenario ${op.scenarioId}`;
    case "scenario.clear-interactions": return `Clear interactions on scenario ${op.scenarioId}`;
  }
}
