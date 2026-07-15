"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineIngest = void 0;
var _relations = require("../core/relations.js");
var _configure = require("./configure.js");
/**
 * Compile a subscription event into ONE event plan: rows, destroys and extract sinks apply with
 * relation side effects (touch/counterCache/dependent) in a single epoch. Version arbitration for
 * stale events lives in the model's merge.shouldOverwrite gate - not here (one gate, no zoo).
 */
const defineIngest = (model, handlers) => ({
  apply: (event, payload) => {
    const declaration = handlers[event]?.(payload) ?? null;
    if (!declaration) return null;
    if (declaration.operationId && (0, _configure.getOperationState)().hasCommitted(declaration.operationId)) return declaration;
    const rows = declaration.upsert == null ? [] : Array.isArray(declaration.upsert) ? declaration.upsert : [declaration.upsert];
    const ids = declaration.destroy == null ? [] : Array.isArray(declaration.destroy) ? declaration.destroy : [declaration.destroy];
    const ops = [];
    if (rows.length > 0) {
      ops.push(...(model.__planRows?.(rows).map(op => op.kind === 'upsert' ? {
        ...op,
        origin: 'event'
      } : op) ?? []));
    }
    if (ids.length > 0) ops.push({
      kind: 'destroy',
      model: model.modelId,
      ids
    });
    for (const sink of declaration.extract ?? []) {
      ops.push(...(sink.into.__planRows?.(sink.rows) ?? []));
    }
    if (ops.length > 0) (0, _configure.getApplyRuntime)().apply((0, _relations.expandPlan)(ops));
    if (declaration.invalidate) model.invalidate();
    return declaration;
  }
});
exports.defineIngest = defineIngest;
//# sourceMappingURL=defineIngest.js.map