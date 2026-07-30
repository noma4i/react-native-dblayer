"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.isSerializedNoop = exports.diffTopLevelFields = exports.createUpsertResolver = void 0;
var _serialize = require("./serialize.js");
var _diagnostics = require("./diagnostics.js");
const diffTopLevelFields = (previous, next) => {
  const fields = new Set();
  for (const key of Object.keys(next)) {
    if (!Object.is(previous[key], next[key])) fields.add(key);
  }
  for (const key of Object.keys(previous)) {
    if (!(key in next)) fields.add(key);
  }
  return [...fields];
};

/** True when every changed field is only a reference change with identical serialized value (upsert guard). */
exports.diffTopLevelFields = diffTopLevelFields;
const isSerializedNoop = (previous, row, changedFields) => changedFields.every(field => (0, _serialize.stableSerialize)(previous[field]) === (0, _serialize.stableSerialize)(row[field]));

/**
 * Pure single-write resolver: id coercion, pending-field overlay, write-gate application, and the
 * serialized-noop upsert guard - no plane state is read or mutated.
 */
exports.isSerializedNoop = isSerializedNoop;
const createUpsertResolver = options => {
  const {
    applyWriteGate,
    ownedFields
  } = options;
  const previewUpsert = (incoming, upsertOptions) => {
    let row = incoming;
    const id = String(row.id);
    if (row.id !== id) row = {
      ...row,
      id
    };
    const previous = upsertOptions.previous;
    const mergePrevious = previous ?? upsertOptions.mergeBase;
    if (previous === row) return {
      row,
      changedFields: []
    };
    const ctx = upsertOptions.ctx ?? {
      origin: 'snapshot'
    };
    if (mergePrevious && ctx.origin !== 'replace' && ctx.operationId === undefined && ownedFields) {
      const owned = ownedFields(row.id, ctx.operationId);
      if (owned.size > 0) {
        let overlaid;
        for (const field of owned) {
          if (!(field in mergePrevious)) continue;
          overlaid ??= {
            ...row
          };
          overlaid[field] = mergePrevious[field];
        }
        row = overlaid ?? row;
      }
    }
    if (mergePrevious) row = applyWriteGate(mergePrevious, row, ctx);
    const changedFields = previous ? diffTopLevelFields(previous, row) : null;
    if (previous && changedFields !== null && changedFields.length > 0 && isSerializedNoop(previous, row, changedFields)) {
      (0, _diagnostics.noteEntityUpsertGuardHit)();
      return {
        row: previous,
        changedFields: []
      };
    }
    return {
      row,
      changedFields
    };
  };
  return {
    previewUpsert
  };
};
exports.createUpsertResolver = createUpsertResolver;
//# sourceMappingURL=storeUpsertResolver.js.map