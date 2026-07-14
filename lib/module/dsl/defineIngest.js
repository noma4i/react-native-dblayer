"use strict";

import { expandPlan } from "../core/relations.js";
import { getApplyRuntime, getOperationState } from "./configure.js";
/**
 * Compile a subscription event into ONE event plan: rows, destroys and extract sinks apply with
 * relation side effects (touch/counterCache/dependent) in a single epoch. Version arbitration for
 * stale events lives in the model's merge.shouldOverwrite gate - not here (one gate, no zoo).
 */
export const defineIngest = (model, handlers) => ({
  apply: (event, payload) => {
    const declaration = handlers[event]?.(payload) ?? null;
    if (!declaration) return null;
    if (declaration.operationId && getOperationState().hasCommitted(declaration.operationId)) return declaration;
    const rows = declaration.upsert == null ? [] : Array.isArray(declaration.upsert) ? declaration.upsert : [declaration.upsert];
    const ids = declaration.destroy == null ? [] : Array.isArray(declaration.destroy) ? declaration.destroy : [declaration.destroy];
    const ops = [];
    if (rows.length > 0) ops.push(...(model.__planRows?.(rows) ?? []));
    if (ids.length > 0) ops.push({
      kind: 'destroy',
      model: model.modelId,
      ids
    });
    for (const sink of declaration.extract ?? []) {
      ops.push(...(sink.into.__planRows?.(sink.rows) ?? []));
    }
    if (ops.length > 0) getApplyRuntime().apply(expandPlan(ops));
    if (declaration.invalidate) model.invalidate();
    return declaration;
  }
});
//# sourceMappingURL=defineIngest.js.map