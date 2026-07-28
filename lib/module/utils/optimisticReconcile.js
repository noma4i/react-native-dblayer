"use strict";

import { isTempId } from "./generateTempId.js";
import { toTimestamp } from "./normalizeHelpers.js";
/**
 * Absolute `createdAt` gap between a candidate and an incoming node, in milliseconds. Missing or
 * unparseable `createdAt` on either side makes `toTimestamp` return `NaN`, which propagates through
 * `Math.abs` to a `NaN` delta - the `!Number.isFinite(delta)` guard in `findBestOptimisticCandidate`
 * deliberately excludes a NaN delta from candidate ranking (never treated as a 0 or best match).
 */
const createdAtDelta = (candidate, node) => Math.abs(toTimestamp(candidate.createdAt) - toTimestamp(node.createdAt));
const resolveScopedCandidates = (model, scope, node) => {
  const filter = {};
  if ('fields' in scope) {
    for (const field of scope.fields) {
      filter[field] = node[field];
    }
  } else {
    for (const [storedField, nodeField] of Object.entries(scope.fieldMap)) {
      if (!nodeField) continue;
      filter[storedField] = node[nodeField];
    }
  }
  return model.where(filter);
};
const candidateAllowed = (candidate, node, isCandidate) => isTempId(candidate.id) || Boolean(isCandidate?.(candidate, node));
const findBestOptimisticCandidate = (candidates, node, options) => {
  let bestCandidate = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (!candidateAllowed(candidate, node, options.isCandidate)) continue;
    if (!options.match(candidate, node)) continue;
    const delta = createdAtDelta(candidate, node);
    if (!Number.isFinite(delta)) continue;
    if (options.createdAtWindowMs !== undefined && delta > options.createdAtWindowMs) continue;
    if (delta < bestDelta) {
      bestDelta = delta;
      bestCandidate = candidate;
    }
  }
  return bestCandidate;
};

/**
 * Reconcile incoming server nodes with matching optimistic rows.
 *
 * @param model Snapshot model used to check existing rows and scoped optimistic candidates.
 * @param nodes Incoming server nodes.
 * @param options Candidate resolution, matching, timestamp window, commit callback, and `onExisting`
 * policy for nodes whose id already exists in the model.
 * @returns Server nodes that were not matched, plus (with `onExisting: 'return'`) nodes whose id already
 * existed in the model.
 */
export const reconcileOptimisticRows = (model, nodes, options) => {
  const unmatched = [];
  for (const node of nodes) {
    if (model.find(node.id)) {
      if (options.onExisting === 'return') {
        unmatched.push(node);
      }
      continue;
    }
    const candidates = typeof options.resolveCandidates === 'function' ? options.resolveCandidates(node) : resolveScopedCandidates(model, options.resolveCandidates, node);
    const bestCandidate = findBestOptimisticCandidate(candidates, node, options);
    if (!bestCandidate) {
      unmatched.push(node);
      continue;
    }
    options.commit(bestCandidate.id, node);
  }
  return unmatched;
};
//# sourceMappingURL=optimisticReconcile.js.map