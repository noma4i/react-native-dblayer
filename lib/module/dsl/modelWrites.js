"use strict";

import { noteDataLoss, noteReplaceRejected, noteTombstoneWriteDrop } from "../core/diagnostics.js";
import { getDbLogger } from "../core/logger.js";
import { putQuarantine } from "../core/quarantine.js";
import { diffTopLevelFields } from "../core/storeUpsertResolver.js";
import { isRecord } from "../utils/normalizeHelpers.js";
import { correlateIncomingRow, modelHasCorrelators } from "./mutationCorrelation.js";
import { getOperationState } from "./configure.js";
export const createModelWrites = options => {
  const prepareRow = (value, previous, origin, mergeBase, operationId, baseRevision) => {
    const incoming = options.normalize(value);
    if (origin === undefined && options.entityState().isTombstoned(incoming.id)) {
      noteTombstoneWriteDrop();
      return null;
    }
    // Replace is a server identity fact: it never fails the causal gate. When the server row
    // already landed through another channel, the response merges into it under snapshot-mode
    // policies instead of leaving the temp row behind.
    const replaceOntoLanded = origin === 'replace' && (previous !== undefined || options.entityState().read(incoming.id) !== undefined);
    const admitted = options.revisions.admitRow(incoming, previous, origin === 'replace' ? undefined : baseRevision);
    if (!admitted) return null;
    return options.entityState().previewUpsert(admitted, {
      previous,
      mergeBase: origin === 'replace' && !replaceOntoLanded ? mergeBase : undefined,
      ctx: {
        origin: replaceOntoLanded ? 'snapshot' : origin ?? 'snapshot',
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
    const destroyLeg = {
      kind: 'destroy',
      model: options.modelId,
      ids: normalized.id === oldId ? [] : [oldId],
      origin: 'replace',
      ...(operationTransitions.length > 0 ? {
        operationTransitions
      } : {})
    };
    // Deletion wins over the landing swap: when the user destroyed this identity while the
    // request was in flight, the temp leg is destroyed too and the server row never lands.
    if (options.entityState().isTombstoned(normalized.id)) {
      noteTombstoneWriteDrop();
      return [destroyLeg];
    }
    const mergeBase = options.entityState().read(oldId);
    const memberships = options.captureMembership(oldId);
    // The landing swap carries the successor id on its destroy leg: freshness chains and other
    // identity followers rewrite the old id instead of treating the swap as a loss.
    return [{
      kind: 'upsert',
      model: options.modelId,
      rows: [normalized],
      origin: 'replace',
      mergeBase
    }, {
      ...destroyLeg,
      ...(destroyLeg.ids.length > 0 ? {
        replacedBy: normalized.id
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
      // Rollback restore is the mirror of the destroy leg: the row logically re-appears, so the
      // event pocket of the effect matrix (counter +1, touch) applies - not the identity-swap pocket.
      const normalized = options.normalize(next);
      return [{
        kind: 'upsert',
        model: options.modelId,
        rows: [normalized],
        origin: 'event'
      }, ...restoreMembership(normalized.id, memberships)];
    }
  };
};
//# sourceMappingURL=modelWrites.js.map