import type { CommitBus } from '../apply/commitBus';
import { getApplyTarget } from '../apply/transaction';
import { ensureModelCollection, ensureMembershipCollection, membershipWriterFor, runInWriteBatch, writerFor } from './facade';

const hasChanged = (current: object, next: object): boolean => {
  const currentRecord = current as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  return Object.keys({ ...currentRecord, ...nextRecord }).some(key => currentRecord[key] !== nextRecord[key]);
};
const scopeOrderCache = new Map<string, Map<string, number>>();

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
          const scopeChanges = (batch.scopeChanges ?? []).filter(change => change.model === modelId && change.scopeKey === scopeKey);
          const structural = scopeChanges.reduce(
            (current, change) => ({
              appendIds: [...new Set([...current.appendIds, ...(change.appendIds ?? [])])],
              detachIds: [...new Set([...current.detachIds, ...(change.detachIds ?? [])])],
              rebuild: current.rebuild || change.rebuild === true
            }),
            { appendIds: [] as string[], detachIds: [] as string[], rebuild: false }
          );
          const meta = target.scopeSortMeta(scopeKey);

          if (meta.kind === `field`) {
            if (structural.rebuild) {
              const existing = memberships.toArray.filter(row => row.scopeKey === scopeKey);
              const expected = target.readScopeOrder(scopeKey).flatMap(rowId => {
                const row = target.readRow(rowId);
                return row ? [{ key: `${scopeKey}\0${rowId}`, scopeKey, rowId, sortValue: row[meta.field] }] : [];
              });
              const expectedKeys = new Set(expected.map(row => row.key));
              for (const row of existing) if (!expectedKeys.has(row.key)) membershipWriter.write({ type: `delete`, key: row.key });
              for (const row of expected) {
                const current = memberships.get(row.key);
                if (!current) membershipWriter.write({ type: `insert`, value: row });
                else if (hasChanged(current, row)) membershipWriter.write({ type: `update`, value: row });
              }
            } else {
              for (const rowId of structural.detachIds) membershipWriter.write({ type: `delete`, key: `${scopeKey}\0${rowId}` });
              for (const rowId of structural.appendIds) {
                const row = target.readRow(rowId);
                if (!row) continue;
                const next = { key: `${scopeKey}\0${rowId}`, scopeKey, rowId, sortValue: row[meta.field] };
                const current = memberships.get(next.key);
                if (!current) membershipWriter.write({ type: `insert`, value: next });
                else if (hasChanged(current, next)) membershipWriter.write({ type: `update`, value: next });
              }
            }
            for (const change of batch.rows) {
              if (change.model !== modelId || !change.fields?.includes(meta.field)) continue;
              const key = `${scopeKey}\0${change.id}`;
              const current = memberships.get(key);
              const row = target.readRow(change.id);
              if (!current || !row) continue;
              const next = { key, scopeKey, rowId: change.id, sortValue: row[meta.field] };
              if (hasChanged(current, next)) membershipWriter.write({ type: `update`, value: next });
            }
            continue;
          }

          if (meta.kind === `server-order` && !structural.rebuild && structural.appendIds.length === 0 && structural.detachIds.length === 0) continue;

          const revision = target.readScopeOrderRevision(scopeKey);
          const modelCache = scopeOrderCache.get(modelId) ?? new Map<string, number>();
          scopeOrderCache.set(modelId, modelCache);
          const orderAffected = batch.rows.some(row => row.model === modelId && target.scopeOrderAffected(scopeKey, row.id, row.fields));
          if (meta.kind === `comparator` && !structural.rebuild && structural.appendIds.length === 0 && structural.detachIds.length === 0 && modelCache.get(scopeKey) === revision && !orderAffected) continue;

          const ids = target.readScopeOrder(scopeKey);
          const expected = ids.map((rowId, seq) => ({ key: `${scopeKey}\0${rowId}`, scopeKey, rowId, seq }));
          const expectedKeys = new Set(expected.map(row => row.key));
          const existing = memberships.toArray.filter(row => row.scopeKey === scopeKey);
          for (const row of existing) if (!expectedKeys.has(row.key)) membershipWriter.write({ type: `delete`, key: row.key });
          for (const row of expected) {
            const current = memberships.get(row.key);
            if (!current) membershipWriter.write({ type: `insert`, value: row });
            else if (hasChanged(current, row)) membershipWriter.write({ type: `update`, value: row });
          }
          modelCache.set(scopeKey, revision);
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
        const meta = target.scopeSortMeta(scopeKey);
        const expected = ids.flatMap((rowId, seq) => {
          const row = target.readRow(rowId);
          if (!row) return [];
          return [meta.kind === `field` ? { key: `${scopeKey}\0${rowId}`, scopeKey, rowId, sortValue: row[meta.field] } : { key: `${scopeKey}\0${rowId}`, scopeKey, rowId, seq }];
        });
        const existing = memberships.toArray.filter(row => row.scopeKey === scopeKey);
        const expectedKeys = new Set(expected.map(row => row.key));
        for (const row of existing) if (!expectedKeys.has(row.key)) membershipWriter.write({ type: `delete`, key: row.key });
        for (const row of expected) {
          const current = memberships.get(row.key);
          if (!current) membershipWriter.write({ type: `insert`, value: row });
          else if (hasChanged(current, row)) membershipWriter.write({ type: `update`, value: row });
        }
        const modelCache = scopeOrderCache.get(modelId) ?? new Map<string, number>();
        scopeOrderCache.set(modelId, modelCache);
        modelCache.set(scopeKey, target.readScopeOrderRevision(scopeKey));
      }
      membershipWriter.commit();
    }
  });
}
