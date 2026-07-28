"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createModelWrites = void 0;
var _diagnostics = require("../core/diagnostics.js");
var _logger = require("../core/logger.js");
var _mutationCorrelation = require("./mutationCorrelation.js");
var _mutationRuntime = require("./mutationRuntime.js");
const createModelWrites = options => {
  const prepareRow = (value, previous, origin, mergeBase, operationId) => {
    const incoming = options.normalize(value);
    if (origin === undefined && options.entityState().isTombstoned(incoming.id)) return null;
    return options.entityState().previewUpsert(incoming, {
      previous,
      mergeBase: origin === 'replace' ? mergeBase : undefined,
      ctx: {
        origin: origin ?? 'snapshot',
        operationId
      }
    });
  };
  const preparePatch = (id, patch, previous, operationId) => {
    if (!previous) return null;
    return options.entityState().previewUpsert({
      ...patch,
      id: String(id)
    }, {
      previous,
      ctx: {
        origin: 'patch',
        operationId
      }
    });
  };
  const putRows = rows => {
    const changes = [];
    for (const row of rows) {
      const result = options.entityState().put(row);
      if (result.changedFields !== null && result.changedFields.length === 0) continue;
      changes.push({
        id: row.id,
        changedFields: result.changedFields
      });
    }
    if (changes.length > 0) options.bumpRevision();
    return changes;
  };
  const restoreMembership = (nextId, memberships) => memberships.map(membership => ({
    kind: 'scope-delta',
    model: options.modelId,
    scopeKey: membership.scopeKey,
    append: [{
      id: nextId,
      order: membership.order,
      edge: membership.edge
    }],
    detach: [membership.id]
  }));
  const replacementId = next => {
    try {
      return options.normalize(next).id;
    } catch {
      return null;
    }
  };
  const planReplace = (oldId, next) => {
    let normalized;
    try {
      normalized = options.normalize(next);
    } catch (error) {
      (0, _logger.getDbLogger)().error('replace rejected', {
        model: options.modelId,
        oldId,
        error
      });
      (0, _diagnostics.noteReplaceRejected)();
      (0, _diagnostics.noteDataLoss)('replacement-rejected', options.modelId, 1);
      throw new Error(`replace rejected for ${options.modelId}:${oldId}`);
    }
    (0, _mutationRuntime.clearFailedOptimisticMutation)(options.modelId, oldId);
    const mergeBase = options.entityState().read(oldId);
    const memberships = options.captureMembership(oldId);
    return [{
      kind: 'destroy',
      model: options.modelId,
      ids: [oldId],
      origin: 'replace'
    }, {
      kind: 'upsert',
      model: options.modelId,
      rows: [normalized],
      origin: 'replace',
      mergeBase
    }, ...restoreMembership(normalized.id, memberships)];
  };
  /**
   * Channel-agnostic temp correlation seam: split already-accepted rows into plain upserts and
   * replace plans for rows that logically ARE a still-open optimistic temp row (per the owning
   * mutation's `correlate` declaration). Every planner of upsert rows (model plans and scope
   * landings alike) routes through this split, so no delivery channel can create a duplicate.
   */
  const splitCorrelatedRows = accepted => {
    if (!(0, _mutationCorrelation.modelHasCorrelators)(options.modelId)) return {
      plain: accepted,
      replaceOps: []
    };
    const plain = [];
    const replaceOps = [];
    const claimedTempIds = new Set();
    for (const value of accepted) {
      const normalized = options.normalize(value);
      const correlation = (0, _mutationCorrelation.correlateIncomingRow)(options.modelId, normalized, {
        readRow: id => options.entityState().read(id),
        claimedTempIds
      });
      if (!correlation) {
        plain.push(normalized);
        continue;
      }
      claimedTempIds.add(correlation.tempId);
      replaceOps.push(...planReplace(correlation.tempId, normalized));
      (0, _mutationCorrelation.closeCorrelatedOperation)(correlation.operation);
    }
    return {
      plain,
      replaceOps
    };
  };
  const planRows = (rows, planOptions) => {
    const split = splitCorrelatedRows(rows.filter(options.isPlanRow));
    const upsert = split.plain.length > 0 || split.replaceOps.length === 0 ? [{
      kind: 'upsert',
      model: options.modelId,
      rows: split.plain,
      ...(planOptions?.origin ? {
        origin: planOptions.origin
      } : {})
    }] : [];
    return [...upsert, ...split.replaceOps];
  };
  return {
    prepareRow,
    preparePatch,
    putRows,
    planRows,
    planReplace,
    splitCorrelatedRows,
    planRestore: (next, memberships) => {
      const normalized = options.normalize(next);
      const nextId = replacementId(next);
      return [{
        kind: 'upsert',
        model: options.modelId,
        rows: [normalized],
        origin: 'replace'
      }, ...(nextId == null ? [] : restoreMembership(nextId, memberships))];
    }
  };
};
exports.createModelWrites = createModelWrites;
//# sourceMappingURL=modelWrites.js.map