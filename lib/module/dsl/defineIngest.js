'use strict';

import { expandPlan } from '../core/relations.js';
import { getApplyRuntime, getDbRuntimeConfig, getOperationState } from './configure.js';
import { getDbLogger } from '../core/logger.js';
/**
 * Compile a subscription event into ONE event plan: rows, destroys and extract sinks apply with
 * relation side effects (touch/counterCache/dependent) in a single epoch. Version arbitration for
 * stale events lives in the model's merge.shouldOverwrite gate - not here (one gate, no zoo).
 */
export const defineIngest = (model, handlers) => ({
  apply: (event, payload) => {
    try {
      const declaration = handlers[event]?.(payload) ?? null;
      if (!declaration) return null;
      if (declaration.operationId && getOperationState().hasCommitted(declaration.operationId)) return declaration;
      const rows = declaration.upsert == null ? [] : Array.isArray(declaration.upsert) ? declaration.upsert : [declaration.upsert];
      const ids = declaration.destroy == null ? [] : Array.isArray(declaration.destroy) ? declaration.destroy : [declaration.destroy];
      const ops = [];
      if (rows.length > 0) {
        ops.push(
          ...(model.__planRows?.(rows).map(op =>
            op.kind === 'upsert'
              ? {
                  ...op,
                  origin: 'event'
                }
              : op
          ) ?? [])
        );
      }
      if (ids.length > 0)
        ops.push({
          kind: 'destroy',
          model: model.modelId,
          ids
        });
      for (const sink of declaration.extract ?? []) {
        ops.push(
          ...(sink.into.__planRows?.(sink.rows).map(op =>
            op.kind === 'upsert'
              ? {
                  ...op,
                  origin: 'event'
                }
              : op
          ) ?? [])
        );
      }
      if (ops.length > 0) getApplyRuntime().apply(expandPlan(ops));
      if (declaration.invalidate) model.invalidate();
      return declaration;
    } catch (error) {
      const reported = error instanceof Error ? error : new Error(String(error));
      try {
        getDbRuntimeConfig().defaults?.onSyncError?.(reported, {
          source: 'ingest',
          model: model.modelId,
          event
        });
      } catch (observerError) {
        getDbLogger().error('defineIngest onSyncError failed', {
          error: observerError
        });
      }
      return null;
    }
  }
});
//# sourceMappingURL=defineIngest.js.map
