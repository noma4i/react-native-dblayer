import type { CommitBus } from '../apply/commitBus';
import { getApplyTarget } from '../apply/transaction';
import { ensureModelCollection, ensureMembershipCollection, membershipWriterFor, runInWriteBatch, writerFor } from './facade';

const hasChanged = (current: object, next: object): boolean => {
  const currentRecord = current as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  return Object.keys({ ...currentRecord, ...nextRecord }).some(key => currentRecord[key] !== nextRecord[key]);
};
const scopeOrderCache = new Map<string, Map<string, { revision: number; order: string[] }>>();

/** Starts synchronously mirroring every commit-bus row batch into TanStack model collections. */
export function startCollectionMirror(bus: CommitBus): () => void {
  return bus.subscribeAll(batch => {
    const rowIdsByModel = new Map<string, Set<string>>();
    const scopeKeysByModel = new Map<string, Set<string>>();
    for (const row of batch.rows) {
      const rowIds = rowIdsByModel.get(row.model) ?? new Set<string>();
      rowIds.add(row.id);
      rowIdsByModel.set(row.model, rowIds);
    }
    for (const change of batch.scopeChanges ?? []) {
      const scopeKeys = scopeKeysByModel.get(change.model) ?? new Set<string>();
      scopeKeys.add(change.scopeKey);
      scopeKeysByModel.set(change.model, scopeKeys);
    }
    for (const change of batch.scopes) {
      const scopeKeys = scopeKeysByModel.get(change.model) ?? new Set<string>();
      scopeKeys.add(change.scopeKey);
      scopeKeysByModel.set(change.model, scopeKeys);
    }

    runInWriteBatch(() => {
      for (const modelId of new Set([...rowIdsByModel.keys(), ...scopeKeysByModel.keys()])) {
        let target;
        try {
          target = getApplyTarget(modelId);
        } catch {
          continue;
        }
        const rowIds = rowIdsByModel.get(modelId) ?? new Set<string>();
        const collection = ensureModelCollection(modelId);
        const writer = writerFor(modelId);
        writer.begin();
        for (const id of rowIds) {
          const row = target.readRow(id);
          const current = collection.get(id);
          if (!row) {
            if (current) writer.write({ type: `delete`, key: id });
            continue;
          }
          const next = { ...row, id };
          if (!current) {
            writer.write({ type: `insert`, value: next });
            continue;
          }
          if (hasChanged(current, next)) {
            writer.write({ type: `update`, value: next });
          }
        }
        writer.commit();
        const scopeKeys = scopeKeysByModel.get(modelId) ?? new Set<string>();
        if (scopeKeys.size === 0) continue;
        const memberships = ensureMembershipCollection(modelId);
        const membershipWriter = membershipWriterFor(modelId);
        membershipWriter.begin();
        for (const scopeKey of scopeKeys) {
          const revision = target.readScopeOrderRevision(scopeKey);
          const modelCache = scopeOrderCache.get(modelId) ?? new Map<string, { revision: number; order: string[] }>();
          scopeOrderCache.set(modelId, modelCache);
          if (modelCache.get(scopeKey)?.revision === revision) continue;
          const ids = target.readScopeOrder(scopeKey);
          const expected = ids.map((rowId, order) => ({
            key: `${scopeKey}\0${rowId}`,
            scopeKey,
            rowId,
            order
          }));
          const existing = memberships.toArray.filter(row => row.scopeKey === scopeKey);
          const matches =
            existing.length === expected.length &&
            expected.every(row => {
              const current = memberships.get(row.key);
              return current?.rowId === row.rowId && current.order === row.order;
            });
          if (matches) continue;
          const expectedKeys = new Set(expected.map(row => row.key));
          for (const row of existing) {
            if (!expectedKeys.has(row.key)) membershipWriter.write({ type: `delete`, key: row.key });
          }
          for (const row of expected) {
            const current = memberships.get(row.key);
            if (!current) membershipWriter.write({ type: `insert`, value: row });
            else if (hasChanged(current, row)) membershipWriter.write({ type: `update`, value: row });
          }
          modelCache.set(scopeKey, { revision, order: ids });
        }
        membershipWriter.commit();
      }
    });
  });
}

/** Seeds model collections from their visible EntityState rows after hydration. */
export function seedCollections(models: string[]): void {
  runInWriteBatch(() => {
    for (const modelId of models) {
      const collection = ensureModelCollection(modelId);
      const writer = writerFor(modelId);
      const target = getApplyTarget(modelId);
      writer.begin();
      for (const row of target.readAllRows()) {
        const id = String(row.id);
        const current = collection.get(id);
        const next = { ...row, id };
        if (!current) {
          writer.write({ type: `insert`, value: next });
          continue;
        }
        if (hasChanged(current, next)) {
          writer.write({ type: `update`, value: next });
        }
      }
      writer.commit();
      const memberships = ensureMembershipCollection(modelId);
      const membershipWriter = membershipWriterFor(modelId);
      membershipWriter.begin();
      for (const scopeKey of target.readAllScopeKeys()) {
        const ids = target.readScopeOrder(scopeKey);
        const expected = ids.map((rowId, order) => ({ key: `${scopeKey}\0${rowId}`, scopeKey, rowId, order }));
        const existing = memberships.toArray.filter(row => row.scopeKey === scopeKey);
        const expectedKeys = new Set(expected.map(row => row.key));
        for (const row of existing) if (!expectedKeys.has(row.key)) membershipWriter.write({ type: `delete`, key: row.key });
        for (const row of expected) {
          const current = memberships.get(row.key);
          if (!current) membershipWriter.write({ type: `insert`, value: row });
          else if (hasChanged(current, row)) membershipWriter.write({ type: `update`, value: row });
        }
        const modelCache = scopeOrderCache.get(modelId) ?? new Map<string, { revision: number; order: string[] }>();
        scopeOrderCache.set(modelId, modelCache);
        modelCache.set(scopeKey, { revision: target.readScopeOrderRevision(scopeKey), order: ids });
      }
      membershipWriter.commit();
    }
  });
}
