"use strict";

import { noteDataLoss, noteReplaceRejected } from "../core/diagnostics.js";
import { getDbLogger } from "../core/logger.js";
import { putQuarantine } from "../core/quarantine.js";
import { diffTopLevelFields } from "../core/storeUpsertResolver.js";
import { isRecord } from "../utils/normalizeHelpers.js";
import { correlateIncomingRow, modelHasCorrelators } from "./mutationCorrelation.js";
import { getOperationState } from "./configure.js";
export const createModelWrites = options => {
  const prepareRow = (value, previous, origin, mergeBase, operationId, baseRevision) => {
    const incoming = options.normalize(value);
    if (origin === undefined && options.entityState().isTombstoned(incoming.id)) return null;
    const admitted = options.revisions.admitRow(incoming, previous, baseRevision);
    if (!admitted) return null;
    return options.entityState().previewUpsert(admitted, {
      previous,
      mergeBase: origin === 'replace' ? mergeBase : undefined,
      ctx: {
        origin: origin ?? 'snapshot',
        operationId
      }
    });
  };
  const preparePatch = (id, patch, previous, operationId, remove = [], baseRevision) => {
    const admitted = options.revisions.admitPatch(id, patch, remove, previous, baseRevision);
    if (!previous || !admitted) return null;
    const prepared = options.entityState().previewUpsert({
      ...admitted.patch,
      id: String(id)
    }, {
      previous,
      ctx: {
        origin: 'patch',
        operationId
      }
    });
    const row = {
      ...prepared.row
    };
    for (const key of admitted.remove) delete row[key];
    return {
      row,
      changedFields: diffTopLevelFields(previous, row)
    };
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
    return changes;
  };
  const restoreMembership = (nextId, memberships) => memberships.map(membership => ({
    kind: 'scope-delta',
    model: options.modelId,
    scopeKey: membership.scopeKey,
    append: [{
      id: nextId,
      orderKey: membership.orderKey
    }],
    detach: nextId === membership.id ? [] : [membership.id]
  }));
  const planReplace = (oldId, next, correlatedOperation) => {
    let normalized;
    try {
      normalized = options.normalize(next);
    } catch (error) {
      getDbLogger().error('replace rejected', {
        model: options.modelId,
        oldId,
        error
      });
      noteReplaceRejected();
      noteDataLoss('replacement-rejected', options.modelId, 1);
      putQuarantine({
        kind: 'row',
        model: options.modelId,
        id: isRecord(next) && next.id !== undefined ? String(next.id) : '',
        raw: next,
        reason: 'replace-normalize-rejected'
      });
      throw new Error(`replace rejected for ${options.modelId}:${oldId}`);
    }
    const failedOperation = getOperationState().failedFor(options.modelId, oldId);
    const operationTransitions = correlatedOperation?.status === 'pending' ? [{
      kind: 'close',
      operationId: correlatedOperation.operationId,
      status: 'committed'
    }] : failedOperation ? [{
      kind: 'remove',
      operationId: failedOperation.operationId,
      expectedStatus: 'failed'
    }] : [];
    const mergeBase = options.entityState().read(oldId);
    const memberships = options.captureMembership(oldId);
    // The upsert leg compiles first so an admission refusal cancels the destroy and detach
    // legs of the same pair; a same-id replace keeps only the transitions of its destroy leg.
    return [{
      kind: 'upsert',
      model: options.modelId,
      rows: [normalized],
      origin: 'replace',
      mergeBase,
      replaceOf: oldId
    }, {
      kind: 'destroy',
      model: options.modelId,
      ids: normalized.id === oldId ? [] : [oldId],
      origin: 'replace',
      ...(operationTransitions.length > 0 ? {
        operationTransitions
      } : {})
    }, ...restoreMembership(normalized.id, memberships)];
  };
  /**
   * Channel-agnostic temp correlation seam: split already-accepted rows into plain upserts and
   * replace plans for rows that logically ARE a still-open optimistic temp row (per the owning
   * mutation's `correlate` declaration). Every planner of upsert rows (model plans and scope
   * landings alike) routes through this split, so no delivery channel can create a duplicate.
   */
  const splitCorrelatedRows = accepted => {
    if (!modelHasCorrelators(options.modelId)) return {
      plain: accepted,
      replaceOps: []
    };
    const plain = [];
    const replaceOps = [];
    const claimedTempIds = new Set();
    for (const value of accepted) {
      const normalized = options.normalize(value);
      const correlation = correlateIncomingRow(options.modelId, normalized, {
        readRow: id => options.entityState().read(id),
        claimedTempIds
      });
      if (!correlation) {
        plain.push(normalized);
        continue;
      }
      claimedTempIds.add(correlation.tempId);
      replaceOps.push(...planReplace(correlation.tempId, normalized, correlation.operation));
    }
    return {
      plain,
      replaceOps
    };
  };
  const planRows = (rows, planOptions) => {
    const split = splitCorrelatedRows(rows.filter(row => options.admitPlanRow(row) !== undefined));
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
      return [{
        kind: 'upsert',
        model: options.modelId,
        rows: [normalized],
        origin: 'replace'
      }, ...restoreMembership(normalized.id, memberships)];
    }
  };
};
//# sourceMappingURL=modelWrites.js.map