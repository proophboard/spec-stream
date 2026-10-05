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
  const result: ExecuteResult = { executed: 0, skipped: 0, failed: 0, errors: [] };

  for (const op of operations) {
    const label = describeOperation(op);
    if (opts.dryRun) {
      opts.log(`[dry-run] ${label}`);
      result.skipped++;
      continue;
    }
    try {
      await executeOne(client, op);
      opts.log(`✓ ${label}`);
      result.executed++;
    } catch (err) {
      const msg = (err as Error).message;
      opts.log(`✗ ${label}: ${msg}`);
      result.failed++;
      result.errors.push({ operation: op, error: msg });
    }
  }

  return result;
}

async function executeOne(client: RestClient, op: SyncBackOperation): Promise<void> {
  const enc = encodeURIComponent;

  switch (op.kind) {
    // ─── Chapter ───────────────────────────────────────────────────────────
    case "chapter.create":
      await client.postJson(`/chapters`, {
        name: op.name,
        ...(op.context !== undefined && { context: op.context }),
        ...(op.mode !== undefined && { mode: op.mode }),
      });
      break;

    case "chapter.rename":
      await client.postJson(`/chapters/${enc(op.chapterId)}/rename`, { new_name: op.newName });
      break;

    case "chapter.update-context":
      await client.patchJson(`/chapters/${enc(op.chapterId)}`, { new_context: op.newContext });
      break;

    case "chapter.delete":
      await client.deleteReq(`/chapters/${enc(op.chapterId)}`);
      break;

    // ─── Lane ─────────────────────────────────────────────────────────────
    case "lane.create":
      await client.postJson(`/chapters/${enc(op.chapterId)}/lanes`, {
        label: op.label,
        type: op.type,
        index: op.index,
        ...(op.height !== undefined && { height: op.height }),
      });
      break;

    case "lane.rename":
      await client.postJson(`/chapters/${enc(op.chapterId)}/lanes/${enc(op.laneId)}/rename`, {
        lane_id: op.laneId,
        new_label: op.newLabel,
      });
      break;

    case "lane.update-details":
      await client.postJson(`/chapters/${enc(op.chapterId)}/lanes/${enc(op.laneId)}/details`, {
        lane_id: op.laneId,
        new_details: op.newDetails,
      });
      break;

    case "lane.resize":
      await client.postJson(`/chapters/${enc(op.chapterId)}/lanes/${enc(op.laneId)}/resize`, {
        lane_id: op.laneId,
        new_height: op.newHeight,
      });
      break;

    case "lane.delete":
      await client.deleteReq(`/chapters/${enc(op.chapterId)}/lanes/${enc(op.laneId)}`);
      break;

    // ─── Slice ────────────────────────────────────────────────────────────
    case "slice.create":
      await client.postJson(`/chapters/${enc(op.chapterId)}/slices`, {
        label: op.label,
        ...(op.index !== undefined && { index: op.index }),
        ...(op.status !== undefined && { status: op.status }),
        ...(op.details !== undefined && { details: op.details }),
        ...(op.width !== undefined && { width: op.width }),
      });
      break;

    case "slice.rename":
      await client.postJson(`/chapters/${enc(op.chapterId)}/slices/${enc(op.sliceId)}/rename`, {
        slice_id: op.sliceId,
        new_label: op.newLabel,
      });
      break;

    case "slice.update-details":
      await client.postJson(`/chapters/${enc(op.chapterId)}/slices/${enc(op.sliceId)}/details`, {
        slice_id: op.sliceId,
        new_details: op.newDetails,
      });
      break;

    case "slice.update-status":
      await client.postJson(`/chapters/${enc(op.chapterId)}/slices/${enc(op.sliceId)}/status`, {
        slice_id: op.sliceId,
        new_status: op.newStatus,
      });
      break;

    case "slice.delete":
      await client.deleteReq(`/chapters/${enc(op.chapterId)}/slices/${enc(op.sliceId)}`);
      break;

    // ─── Element ──────────────────────────────────────────────────────────
    case "element.create":
      await client.postJson(`/chapters/${enc(op.chapterId)}/elements`, {
        name: op.name,
        type: op.type,
        lane_id: op.laneId,
        slice_id: op.sliceId,
        ...(op.description !== undefined && { description: op.description }),
        ...(op.details !== undefined && { details: op.details }),
        ...(op.index !== undefined && { index: op.index }),
        ...(op.context !== undefined && { context: op.context }),
      });
      break;

    case "element.rename":
      await client.postJson(`/chapters/${enc(op.chapterId)}/elements/${enc(op.elementId)}/rename`, {
        new_name: op.newName,
      });
      break;

    case "element.update-description":
      await client.postJson(`/chapters/${enc(op.chapterId)}/elements/${enc(op.elementId)}/description`, {
        new_description: op.newDescription,
      });
      break;

    case "element.update-details":
      await client.postJson(`/chapters/${enc(op.chapterId)}/elements/${enc(op.elementId)}/details`, {
        new_details: op.newDetails,
      });
      break;

    case "element.update-config":
      await client.postJson(`/chapters/${enc(op.chapterId)}/elements/${enc(op.elementId)}/config`, {
        ...(op.playFunction !== undefined && { play_function: op.playFunction }),
        ...(op.playType !== undefined && { play_type: op.playType }),
      });
      break;

    case "element.move":
      await client.postJson(`/chapters/${enc(op.chapterId)}/elements/${enc(op.elementId)}/move`, {
        element_id: op.elementId,
        new_lane_id: op.newLaneId,
        new_slice_id: op.newSliceId,
        new_index: op.newIndex,
      });
      break;

    case "element.delete":
      await client.deleteReq(`/chapters/${enc(op.chapterId)}/elements/${enc(op.elementId)}`);
      break;

    // ─── Milestone ────────────────────────────────────────────────────────
    case "milestone.create":
      await client.postJson(`/milestones`, {
        name: op.name,
        ...(op.description !== undefined && { description: op.description }),
        ...(op.deadline !== undefined && { deadline: op.deadline }),
        ...(op.color !== undefined && { color: op.color }),
      });
      break;

    case "milestone.update":
      await client.patchJson(`/milestones/${enc(op.milestoneId)}`, {
        ...(op.name !== undefined && { name: op.name }),
        ...(op.description !== undefined && { description: op.description }),
        ...(op.deadline !== undefined && { deadline: op.deadline }),
        ...(op.color !== undefined && { color: op.color }),
      });
      break;

    case "milestone.delete":
      await client.deleteReq(`/milestones/${enc(op.milestoneId)}`);
      break;

    // ─── HTML Snippet ─────────────────────────────────────────────────────
    case "html-snippet.create":
      await client.postJson(`/snippets`, {
        name: op.name,
        snippet: op.snippet,
        ...(op.slug !== undefined && { slug: op.slug }),
      });
      break;

    case "html-snippet.update":
      await client.patchJson(`/snippets/${enc(op.slug)}`, {
        ...(op.name !== undefined && { name: op.name }),
        ...(op.snippet !== undefined && { snippet: op.snippet }),
      });
      break;

    case "html-snippet.delete":
      await client.deleteReq(`/snippets/${enc(op.slug)}`);
      break;

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
      break;

    case "scenario.remove-expectation":
      await client.deleteReq(
        `/chapters/${enc(op.chapterId)}/scenarios/${enc(op.scenarioId)}/expectations/${enc(op.expectationId)}`,
      );
      break;

    default:
      throw new Error(`Unknown operation kind: ${(op as SyncBackOperation).kind}`);
  }
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
    case "scenario.set-expectation":   return `Set expectation ${op.expectation.id} (${op.expectation.kind}) on scenario ${op.scenarioId}`;
    case "scenario.remove-expectation": return `Remove expectation ${op.expectationId} from scenario ${op.scenarioId}`;
  }
}
