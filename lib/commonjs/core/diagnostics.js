"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.noteUnknownOperationAck = exports.noteTombstoneWriteDrop = exports.noteScopeReadPass = exports.noteResumeDrain = exports.noteReplaceRejected = exports.noteRelationChildScan = exports.noteReadEngineScan = exports.noteReadEngineApply = exports.noteQuarantinePut = exports.noteNonResidentTouchDrop = exports.noteMembershipWrites = exports.noteMembershipMissingEntity = exports.noteManifestReset = exports.noteEntityUpsertGuardHit = exports.noteDataLoss = exports.noteCounterOpDrop = exports.noteCorruptionLedgerReset = exports.noteCommitFanout = exports.noteCommit = exports.noteChainSurvivorShrink = exports.noteCausalAdmissionDrop = exports.noteApplyFailure = void 0;
var _reset = require("./reset.js");
const emptyDiagnostics = () => ({
  commits: 0,
  commitFanoutCandidates: 0,
  commitFanoutNotified: 0,
  readEngineApplies: 0,
  readEngineDeltaRows: 0,
  readEngineScanRows: 0,
  scopeReadPasses: 0,
  scopeReadResorts: 0,
  resumeDrains: 0,
  resumeRefetches: 0,
  entityUpsertGuardHits: 0,
  membershipWrites: 0,
  relationChildScans: 0,
  corruptionLedgerResets: 0,
  manifestResets: 0,
  replaceRejected: 0,
  applyFailure: 0,
  quarantinePuts: 0,
  tombstoneWriteDrops: 0,
  chainSurvivorShrinks: 0,
  membershipMissingEntity: 0,
  counterOpDrops: 0,
  nonResidentTouchDrops: 0,
  unknownOperationAcks: 0,
  causalAdmissionDrops: 0,
  dataLossEvents: []
});
let diagnostics = emptyDiagnostics();
const noteCommit = () => {
  diagnostics.commits += 1;
};
exports.noteCommit = noteCommit;
const noteCommitFanout = (candidates, notified) => {
  diagnostics.commitFanoutCandidates += candidates;
  diagnostics.commitFanoutNotified += notified;
};

/** One incremental update of a declared query, sized by the rows it moved. */
exports.noteCommitFanout = noteCommitFanout;
const noteReadEngineApply = rows => {
  diagnostics.readEngineApplies += 1;
  diagnostics.readEngineDeltaRows += rows;
};

/** Record one model-read scan by its row count, without per-row instrumentation. */
exports.noteReadEngineApply = noteReadEngineApply;
const noteReadEngineScan = rows => {
  diagnostics.readEngineScanRows += rows;
};
exports.noteReadEngineScan = noteReadEngineScan;
const noteScopeReadPass = resorted => {
  diagnostics.scopeReadPasses += 1;
  if (resorted) diagnostics.scopeReadResorts += 1;
};
exports.noteScopeReadPass = noteScopeReadPass;
const noteResumeDrain = refetched => {
  diagnostics.resumeDrains += 1;
  diagnostics.resumeRefetches += refetched;
};
exports.noteResumeDrain = noteResumeDrain;
const noteEntityUpsertGuardHit = () => {
  diagnostics.entityUpsertGuardHits += 1;
};

/** Count membership feed messages actually written - the work-counter behind same-pairs replaceAll staying at zero. */
exports.noteEntityUpsertGuardHit = noteEntityUpsertGuardHit;
const noteRelationChildScan = () => {
  diagnostics.relationChildScans += 1;
};
exports.noteRelationChildScan = noteRelationChildScan;
const noteMembershipWrites = count => {
  diagnostics.membershipWrites += count;
};
exports.noteMembershipWrites = noteMembershipWrites;
const noteCorruptionLedgerReset = () => {
  diagnostics.corruptionLedgerResets += 1;
};

/** Count cold resets caused by an incompatible persistence manifest. */
exports.noteCorruptionLedgerReset = noteCorruptionLedgerReset;
const noteManifestReset = () => {
  diagnostics.manifestResets += 1;
};
exports.noteManifestReset = noteManifestReset;
const noteReplaceRejected = () => {
  diagnostics.replaceRejected += 1;
};

/** A plan failed both its initial atomic apply and clean retry; reads remain poisoned. */
exports.noteReplaceRejected = noteReplaceRejected;
const noteApplyFailure = () => {
  diagnostics.applyFailure += 1;
};

/** Count payloads kept in the quarantine instead of being dropped. */
exports.noteApplyFailure = noteApplyFailure;
const noteQuarantinePut = () => {
  diagnostics.quarantinePuts += 1;
};

/** Count landings gated out by a live tombstone - the discriminator for vanished-window defects. */
exports.noteQuarantinePut = noteQuarantinePut;
const noteTombstoneWriteDrop = () => {
  diagnostics.tombstoneWriteDrops += 1;
};

/** Count query chains shrunk by materialization loss while survivors remain. */
exports.noteTombstoneWriteDrop = noteTombstoneWriteDrop;
const noteChainSurvivorShrink = () => {
  diagnostics.chainSurvivorShrinks += 1;
};

/** Count scope members whose entity row is absent at read time - must stay 0 after boot fsck. */
exports.noteChainSurvivorShrink = noteChainSurvivorShrink;
const noteMembershipMissingEntity = count => {
  if (count > 0) diagnostics.membershipMissingEntity += count;
};

/** Count counter ops skipped for a non-resident parent or non-numeric base. */
exports.noteMembershipMissingEntity = noteMembershipMissingEntity;
const noteCounterOpDrop = () => {
  diagnostics.counterOpDrops += 1;
};

/** Count touch effects dropped because the parent row is not resident in the plan. */
exports.noteCounterOpDrop = noteCounterOpDrop;
const noteNonResidentTouchDrop = () => {
  diagnostics.nonResidentTouchDrops += 1;
};

/** Count terminal ledger acks aimed at an unknown or already-closed operation. */
exports.noteNonResidentTouchDrop = noteNonResidentTouchDrop;
const noteUnknownOperationAck = () => {
  diagnostics.unknownOperationAcks += 1;
};

/** Count rows or fields evicted by causal admission (stale baseRevision against newer committed state). */
exports.noteUnknownOperationAck = noteUnknownOperationAck;
const noteCausalAdmissionDrop = () => {
  diagnostics.causalAdmissionDrops += 1;
};

/** Append a bounded, inspectable record whenever a row, membership, guard, or operation is discarded. */
exports.noteCausalAdmissionDrop = noteCausalAdmissionDrop;
const noteDataLoss = (mechanism, model, count) => {
  if (count <= 0) return;
  diagnostics.dataLossEvents.push({
    mechanism,
    model,
    count
  });
  if (diagnostics.dataLossEvents.length > 100) diagnostics.dataLossEvents.splice(0, diagnostics.dataLossEvents.length - 100);
};
exports.noteDataLoss = noteDataLoss;
const snapshotDiagnostics = () => ({
  ...diagnostics,
  dataLossEvents: [...diagnostics.dataLossEvents]
});
const resetDiagnostics = () => {
  diagnostics = emptyDiagnostics();
};
(0, _reset.registerReset)(resetDiagnostics);
globalThis.__DBLAYER_DIAGNOSTICS__ = {
  snapshot: snapshotDiagnostics,
  reset: resetDiagnostics
};
//# sourceMappingURL=diagnostics.js.map