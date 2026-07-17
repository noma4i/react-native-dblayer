import type { JournalOp } from '../core/apply/journal';
import { expandPlan } from '../core/relations';
import { getApplyRuntime, getDbRuntimeConfig, getOperationState } from './configure';
import { getDbLogger } from '../core/logger';
import type { ExtractSink } from './defineQuery';

export type IngestDecl = {
  upsert?: unknown | unknown[];
  destroy?: string | string[];
  invalidate?: boolean;
  /** Echo guard: when this operation id already committed locally, the whole event is skipped. */
  operationId?: string | null;
  /** Cross-model sideloads applied in the SAME transaction as the event rows. */
  extract?: ExtractSink[];
};

export type IngestHandle = { apply(event: string, payload: unknown): IngestDecl | null };

type IngestModel = {
  modelId: string;
  invalidate(scope?: unknown): void;
  __planRows?(rows: unknown[]): JournalOp[];
};

/**
 * Compile a subscription event into ONE event plan: rows, destroys and extract sinks apply with
 * relation side effects (touch/counterCache/dependent) in a single epoch. Version arbitration for
 * stale events lives in the model's merge.shouldOverwrite gate - not here (one gate, no zoo).
 */
export const defineIngest = (model: IngestModel, handlers: Record<string, (payload: unknown) => IngestDecl | null>): IngestHandle => ({
  apply: (event, payload) => {
    try {
    const declaration = handlers[event]?.(payload) ?? null;
    if (!declaration) return null;
    if (declaration.operationId && getOperationState().hasCommitted(declaration.operationId)) return declaration;
    const rows = declaration.upsert == null ? [] : Array.isArray(declaration.upsert) ? declaration.upsert : [declaration.upsert];
    const ids = declaration.destroy == null ? [] : Array.isArray(declaration.destroy) ? declaration.destroy : [declaration.destroy];
    const ops: JournalOp[] = [];
    if (rows.length > 0) {
      ops.push(...(model.__planRows?.(rows).map(op => (op.kind === 'upsert' ? { ...op, origin: 'event' as const } : op)) ?? []));
    }
    if (ids.length > 0) ops.push({ kind: 'destroy', model: model.modelId, ids });
    for (const sink of declaration.extract ?? []) {
      ops.push(...(sink.into.__planRows?.(sink.rows).map(op => (op.kind === 'upsert' ? { ...op, origin: 'event' as const } : op)) ?? []));
    }
    if (ops.length > 0) getApplyRuntime().apply(expandPlan(ops));
    if (declaration.invalidate) model.invalidate();
    return declaration;
    } catch (error) {
      const reported = error instanceof Error ? error : new Error(String(error));
      try { getDbRuntimeConfig().defaults?.onSyncError?.(reported, { source: 'ingest', model: model.modelId, event }); } catch (observerError) { getDbLogger().error('defineIngest onSyncError failed', { error: observerError }); }
      return null;
    }
  }
});
