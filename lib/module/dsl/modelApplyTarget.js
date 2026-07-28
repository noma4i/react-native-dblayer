"use strict";

import { createCommitEnvelope, registerApplyTarget } from "../core/apply/transaction.js";
import { getApplyRuntime } from "./configure.js";
export const createModelApplyTarget = options => {
  const {
    planes
  } = options.context;
  const applyTarget = {
    readRow: id => planes().entityState.read(id),
    readAllRows: () => planes().entityState.values(),
    readScopeOrder: scopeKey => {
      const separator = scopeKey.indexOf(`\0`);
      const scopeName = separator < 0 ? scopeKey : scopeKey.slice(0, separator);
      const rawValue = separator < 0 ? `{}` : scopeKey.slice(separator + 1);
      try {
        return options.scopeSortedRows(scopeName, JSON.parse(rawValue)).map(row => String(row.id));
      } catch {
        return planes().scopeIndex.read(scopeKey).entries.map(entry => entry.id);
      }
    },
    readScopeOrderRevision: scopeKey => planes().scopeIndex.orderRevision(scopeKey),
    readScopeGeneration: scopeKey => planes().scopeIndex.read(scopeKey).generation,
    scopeOrderAffected: (scopeKey, id, fields) => {
      if (fields === null || !planes().scopeIndex.has(scopeKey, id)) return true;
      const scopeName = scopeKey.slice(0, scopeKey.indexOf(`\0`));
      const spec = options.scopes?.[scopeName];
      if (!spec) return false;
      const relevant = new Set(spec.by ? Object.values(spec.by) : []);
      if (spec.sort && spec.sort !== 'server-order' && 'field' in spec.sort) relevant.add(String(spec.sort.field));
      if (spec.sort && spec.sort !== 'server-order' && 'comparator' in spec.sort) {
        if (spec.sort.orderFields === undefined) return true;
        for (const field of spec.sort.orderFields) relevant.add(field);
      }
      return fields.some(field => relevant.has(field));
    },
    scopeSortMeta: scopeKey => {
      const scopeName = scopeKey.slice(0, scopeKey.indexOf(`\0`));
      const sort = options.scopes?.[scopeName]?.sort;
      if (!sort || sort === 'server-order') return {
        kind: 'server-order'
      };
      if ('comparator' in sort) return {
        kind: 'comparator'
      };
      return {
        kind: 'field',
        field: String(sort.field),
        dir: sort.dir
      };
    },
    readAllScopeKeys: () => planes().scopeIndex.keys(),
    prepareUpsert: (row, previous, origin, mergeBase, operationId) => options.prepareRow(row, previous, origin, mergeBase, operationId),
    preparePatch: (id, patch, previous, operationId) => options.preparePatch(id, patch, previous, operationId),
    put: rows => options.putRows(rows),
    destroy: (ids, tombstone) => {
      const removed = [];
      for (const id of ids) {
        const key = String(id);
        const existed = planes().entityState.read(key) !== undefined;
        planes().entityState.destroy(key, {
          tombstone
        });
        if (existed) removed.push(key);
      }
      if (removed.length > 0) options.context.bumpRevision();
      return removed;
    },
    scope: (scopeKey, next) => {
      planes().scopeIndex.write(scopeKey, next);
    },
    scopeDelta: (scopeKey, delta) => {
      if (delta.detach.length > 0) planes().scopeIndex.detach(scopeKey, delta.detach);
      if (delta.append.length > 0) planes().scopeIndex.reconcile(scopeKey, 'delta', delta.append);
    },
    reactiveScopes: ids => planes().scopeIndex.touchMembers(ids),
    persistEntries: () => [...planes().entityState.persistEntries(), ...planes().scopeIndex.persistEntries()],
    ackPersist: () => {
      planes().entityState.ackPersist();
      planes().scopeIndex.ackPersist();
    }
  };
  registerApplyTarget(options.modelId, applyTarget);
  const applySnapshot = ops => {
    getApplyRuntime().commit(createCommitEnvelope(ops));
  };
  const applyEvent = ops => {
    getApplyRuntime().commit(createCommitEnvelope(ops.map(op => op.kind === 'upsert' && op.origin === undefined ? {
      kind: 'upsert',
      model: op.model,
      rows: op.rows,
      origin: 'event'
    } : op)));
  };
  return {
    applyTarget,
    applySnapshot,
    applyEvent
  };
};
//# sourceMappingURL=modelApplyTarget.js.map