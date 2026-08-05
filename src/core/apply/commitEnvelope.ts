import type { AcceptedRow, CommitEnvelope, DestroyedRow, AppliedOp, OperationTransition, StoredRow, WriteOp } from '../../types';
import { getRuntimeGeneration } from '../../dsl/configure';
import { noteCounterOpDrop } from '../diagnostics';
import { deduplicateScopeEntriesById } from '../planes/scopeIndex';
import { deriveEffects } from '../relations';
import { compositeKey } from '../serialize';
import { getApplyTarget } from './applyTargetRegistry';

const isScopeOperation = (op: AppliedOp): boolean => op.kind === 'scope' || op.kind === 'scope-delta';
let transactionSequence = 0;

const readPlannedRow = (overlay: Map<string, Map<string, StoredRow | null>>, model: string, id: string): StoredRow | undefined => {
  const modelOverlay = overlay.get(model);
  if (modelOverlay?.has(id)) return modelOverlay.get(id) ?? undefined;
  return getApplyTarget(model).readRow(id);
};

const writePlannedRow = (overlay: Map<string, Map<string, StoredRow | null>>, model: string, id: string, row: StoredRow | null): void => {
  const modelOverlay = overlay.get(model) ?? new Map<string, StoredRow | null>();
  modelOverlay.set(id, row);
  overlay.set(model, modelOverlay);
};

const readPlannedRows = (overlay: Map<string, Map<string, StoredRow | null>>, model: string): StoredRow[] => {
  const rows = new Map(
    getApplyTarget(model)
      .readAllRows()
      .flatMap(row => (typeof row.id === 'string' ? [[row.id, row] as const] : []))
  );
  for (const [id, row] of overlay.get(model) ?? []) {
    if (row === null) rows.delete(id);
    else rows.set(id, row);
  }
  return [...rows.values()];
};

const prepareOperations = (ops: WriteOp[], overlay: Map<string, Map<string, StoredRow | null>>) => {
  const preparedOps: AppliedOp[] = [];
  const accepted: AcceptedRow[] = [];
  const destroyed: DestroyedRow[] = [];
  const operationTransitions: OperationTransition[] = [];
  for (const op of ops) {
    const target = getApplyTarget(op.model);
    if (op.kind === 'upsert') {
      const rows: StoredRow[] = [];
      for (const input of op.rows) {
        const inputId = typeof input === 'object' && input !== null && 'id' in input ? String((input as { id: unknown }).id) : '';
        const previous = inputId ? readPlannedRow(overlay, op.model, inputId) : undefined;
        const mergeBase = op.origin === 'replace' && typeof op.mergeBase === 'object' && op.mergeBase !== null ? (op.mergeBase as StoredRow) : undefined;
        const prepared = target.prepareUpsert(input, previous, op.origin, mergeBase, op.operationId, op.baseRevision);
        if (!prepared || (prepared.changedFields !== null && prepared.changedFields.length === 0)) continue;
        const id = prepared.row.id;
        if (typeof id !== 'string' || id.length === 0) throw new Error(`Prepared row for ${op.model} has no string id`);
        writePlannedRow(overlay, op.model, id, prepared.row);
        rows.push(prepared.row);
        accepted.push({
          model: op.model,
          id,
          before: op.origin === 'replace' ? mergeBase : previous,
          after: prepared.row,
          origin: op.origin,
          changedFields: prepared.changedFields
        });
      }
      if (rows.length > 0) preparedOps.push({ kind: 'upsert', model: op.model, rows, ...(op.origin === 'replace' ? { origin: op.origin } : {}) });
      continue;
    }
    if (op.kind === 'patch') {
      const patchId = String(op.id);
      const previous = readPlannedRow(overlay, op.model, patchId);
      const prepared = target.preparePatch(patchId, op.patch, previous, op.operationId, op.remove, op.baseRevision);
      if (!prepared || (prepared.changedFields !== null && prepared.changedFields.length === 0)) continue;
      const id = String(prepared.row.id);
      writePlannedRow(overlay, op.model, id, prepared.row);
      preparedOps.push({ kind: 'upsert', model: op.model, rows: [prepared.row] });
      accepted.push({ model: op.model, id, before: previous, after: prepared.row, changedFields: prepared.changedFields });
      continue;
    }
    if (op.kind === 'counter') {
      const counterId = String(op.id);
      const previous = readPlannedRow(overlay, op.model, counterId);
      if (!previous) {
        noteCounterOpDrop();
        continue;
      }
      const value = previous[op.field];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        noteCounterOpDrop();
        continue;
      }
      const prepared = target.preparePatch(counterId, { [op.field]: value + op.delta }, previous);
      if (!prepared || (prepared.changedFields !== null && prepared.changedFields.length === 0)) continue;
      const id = String(prepared.row.id);
      writePlannedRow(overlay, op.model, id, prepared.row);
      preparedOps.push({ kind: 'upsert', model: op.model, rows: [prepared.row] });
      accepted.push({ model: op.model, id, before: previous, after: prepared.row, changedFields: prepared.changedFields });
      continue;
    }
    if (op.kind === 'destroy') {
      operationTransitions.push(...(op.operationTransitions ?? []));
      const destroyIds = op.ids.map(String);
      const existingDestroyIds: string[] = [];
      for (const id of destroyIds) {
        if (!target.admitDestroy(id, op.baseRevision)) continue;
        const previous = readPlannedRow(overlay, op.model, id);
        if (!previous) continue;
        existingDestroyIds.push(id);
        destroyed.push({ model: op.model, id, before: previous, origin: op.origin });
        writePlannedRow(overlay, op.model, id, null);
      }
      if (existingDestroyIds.length === 0) continue;
      preparedOps.push({
        kind: 'destroy',
        model: op.model,
        ids: existingDestroyIds,
        ...(op.tombstone !== undefined ? { tombstone: op.tombstone } : {}),
        ...(op.origin ? { origin: op.origin } : {}),
        ...(op.replacedBy !== undefined ? { replacedBy: op.replacedBy } : {})
      });
      continue;
    }
    // Membership authority is the FINAL committed row: an entry whose planned row no longer
    // belongs to the scope (member predicate, derived by-value after write policies) is gated
    // out, so a landing grouped by a raw pre-policy value cannot seat one identity in 2 buckets.
    const entryBelongs = (scopeKey: string) => (entry: { id: string }) => {
      const row = readPlannedRow(overlay, op.model, entry.id);
      return !row || target.rowBelongsToScope(scopeKey, row);
    };
    if (op.kind === 'scope') {
      preparedOps.push({ ...op, next: { ...op.next, entries: op.next.entries.filter(entryBelongs(op.scopeKey)) } });
      continue;
    }
    if (op.kind === 'scope-delta') {
      const append = deduplicateScopeEntriesById(op.append).filter(entryBelongs(op.scopeKey));
      const keyless = append.filter(entry => entry.orderKey === undefined).map(entry => entry.id);
      const placed =
        keyless.length > 0
          ? new Map(target.planScopePlacement(op.scopeKey, keyless, (model, id) => readPlannedRow(overlay, model, id)).map(entry => [entry.id, entry.orderKey] as const))
          : new Map<string, string>();
      preparedOps.push({
        kind: 'scope-delta',
        model: op.model,
        scopeKey: op.scopeKey,
        append: append.map(entry => ({ id: entry.id, orderKey: entry.orderKey ?? placed.get(entry.id)! })),
        detach: [...op.detach]
      });
      continue;
    }
    preparedOps.push(op);
  }
  return { ops: preparedOps, accepted, destroyed, operationTransitions };
};

const compileWritePlan = (initialOps: WriteOp[]): { ops: AppliedOp[]; operationTransitions: OperationTransition[] } => {
  for (const op of initialOps) getApplyTarget(op.model);
  const overlay = new Map<string, Map<string, StoredRow | null>>();
  const sourceOps = [...initialOps];
  const planned: AppliedOp[] = [];
  const operationTransitions: OperationTransition[] = [];
  let phase = prepareOperations(initialOps, overlay);
  planned.push(...phase.ops);
  operationTransitions.push(...phase.operationTransitions);
  const allAccepted = [...phase.accepted];
  while (phase.accepted.length > 0 || phase.destroyed.length > 0) {
    const effects = deriveEffects(phase.accepted, phase.destroyed, sourceOps, {
      read: (model, id) => readPlannedRow(overlay, model, id),
      rows: model => readPlannedRows(overlay, model)
    });
    if (effects.length === 0) break;
    sourceOps.push(...effects);
    phase = prepareOperations(effects, overlay);
    planned.push(...phase.ops);
    operationTransitions.push(...phase.operationTransitions);
    allAccepted.push(...phase.accepted);
  }

  const repositioned = new Map<string, AppliedOp>();
  const repositionGroups = new Map<string, { model: string; scopeKey: string; ids: Set<string> }>();
  const planTouched = new Set<string>();
  for (const op of planned) {
    if (op.kind !== 'scope-delta') continue;
    for (const entry of op.append) planTouched.add(compositeKey(op.model, op.scopeKey, entry.id));
    for (const id of op.detach) planTouched.add(compositeKey(op.model, op.scopeKey, id));
  }
  for (const row of allAccepted) {
    const target = getApplyTarget(row.model);
    for (const scopeKey of target.reactiveScopes?.([row.id]) ?? []) {
      if (planTouched.has(compositeKey(row.model, scopeKey, row.id))) continue;
      if (target.scopeSortMeta(scopeKey).kind === 'server-order') continue;
      if (!target.scopeOrderAffected(scopeKey, row.id, row.changedFields)) continue;
      const groupKey = compositeKey(row.model, scopeKey);
      const group = repositionGroups.get(groupKey) ?? { model: row.model, scopeKey, ids: new Set<string>() };
      group.ids.add(row.id);
      repositionGroups.set(groupKey, group);
    }
  }
  for (const group of repositionGroups.values()) {
    const target = getApplyTarget(group.model);
    const placements = target.planScopePlacement(group.scopeKey, [...group.ids], (model, id) => readPlannedRow(overlay, model, id));
    for (const placement of placements) {
      repositioned.set(compositeKey(group.model, group.scopeKey, placement.id), {
        kind: 'scope-delta',
        model: group.model,
        scopeKey: group.scopeKey,
        append: [{ id: placement.id, orderKey: placement.orderKey }],
        detach: []
      });
    }
  }
  planned.push(...repositioned.values());
  return { ops: planned, operationTransitions };
};

/**
 * Compile raw model intents into one complete callback-free plan before the commit.
 *
 * @param ops Raw model write intents.
 * @param explicitOperationTransitions Durable operation-ledger transitions composed with the plan.
 * @returns A complete commit envelope with entity work ordered before scope membership work.
 */
export const createCommitEnvelope = (ops: WriteOp[], explicitOperationTransitions: readonly OperationTransition[] = []): CommitEnvelope => {
  const runtimeEpoch = getRuntimeGeneration();
  const planned = compileWritePlan(ops);
  const operationTransitions = [...planned.operationTransitions, ...explicitOperationTransitions];
  transactionSequence += 1;
  return {
    schemaVersion: 1,
    txId: `${runtimeEpoch}:${transactionSequence}`,
    epoch: runtimeEpoch,
    entityOps: planned.ops.filter(op => !isScopeOperation(op)),
    scopeOps: planned.ops.filter(isScopeOperation),
    operationTransitions
  } as unknown as CommitEnvelope;
};
