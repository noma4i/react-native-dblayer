"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.registerMutationCorrelator = exports.modelHasCorrelators = exports.correlateIncomingRow = exports.closeCorrelatedOperation = void 0;
var _generateTempId = require("../utils/generateTempId.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
var _configure = require("./configure.js");
/**
 * Definition registry of declarative temp-row correlators (one entry per insert-optimistic mutation
 * that declares `correlate`). Definition registries deliberately survive `resetRuntime`, matching
 * the model/maintenance registries: declarations describe the schema of behavior, not runtime rows.
 */
const correlators = new Map();
const registerMutationCorrelator = (modelId, correlate) => {
  const entries = correlators.get(modelId) ?? [];
  entries.push(correlate);
  correlators.set(modelId, entries);
};

/** Fast hot-path gate: models without a declared correlator skip normalization and candidate scans entirely. */
exports.registerMutationCorrelator = registerMutationCorrelator;
const modelHasCorrelators = modelId => (correlators.get(modelId)?.length ?? 0) > 0;
exports.modelHasCorrelators = modelHasCorrelators;
const rowTimestamp = row => {
  const value = row.createdAt;
  return typeof value === 'string' || typeof value === 'number' || value instanceof Date ? (0, _normalizeHelpers.toTimestamp)(value) : Number.NaN;
};
const candidateMatches = (correlate, candidate, incoming) => {
  for (const field of correlate.fields) {
    if (!Object.is(candidate[field], incoming[field])) return false;
  }
  if (correlate.match && !correlate.match(candidate, incoming)) return false;
  if (correlate.createdAtWindowMs !== undefined) {
    const delta = Math.abs(rowTimestamp(candidate) - rowTimestamp(incoming));
    if (!Number.isFinite(delta) || delta > correlate.createdAtWindowMs) return false;
  }
  return true;
};

/**
 * Resolve the still-open temp row an incoming server row logically IS, per the model's declared
 * correlators. Candidates come from the durable ledger (open insert operations), never from a
 * whole-model scan; ties resolve to the oldest operation (FIFO - servers confirm sends in order).
 * Returns null for temp ids, rows already present, models without correlators, or no match.
 */
const correlateIncomingRow = (modelId, incoming, options) => {
  const declared = correlators.get(modelId);
  if (!declared || declared.length === 0) return null;
  if ((0, _generateTempId.isTempId)(incoming.id)) return null;
  if (options.readRow(incoming.id) !== undefined) return null;
  let best = null;
  for (const operation of (0, _configure.getOperationState)().openInsertsFor(modelId)) {
    const tempId = operation.tempIds[0];
    if (tempId === undefined || options.claimedTempIds.has(tempId)) continue;
    const candidate = options.readRow(tempId);
    if (!candidate) continue;
    if (!declared.some(correlate => candidateMatches(correlate, candidate, incoming))) continue;
    if (!best || operation.createdAt < best.operation.createdAt || operation.createdAt === best.operation.createdAt && operation.operationId < best.operation.operationId) {
      best = {
        tempId,
        operation
      };
    }
  }
  return best;
};

/** Close a correlated pending operation as committed: its row was confirmed through another channel. */
exports.correlateIncomingRow = correlateIncomingRow;
const closeCorrelatedOperation = operation => {
  if (operation.status === 'pending') (0, _configure.getOperationState)().close(operation.operationId, 'committed');
};
exports.closeCorrelatedOperation = closeCorrelatedOperation;
//# sourceMappingURL=mutationCorrelation.js.map