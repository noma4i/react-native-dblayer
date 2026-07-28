"use strict";

import { createCommitEnvelope, registerApplyTarget } from "../core/apply/transaction.js";
import { keysForSequence } from "../core/orderKey.js";
import { getApplyRuntime } from "./configure.js";
import { compareRowsBySpec } from "./modelReadAccess.js";
export const createModelApplyTarget = options => {
  const {
    planes
  } = options.context;
  const applyTarget = {
    readRow: id => planes().entityState.read(id),
    readAllRows: () => planes().entityState.values(),
    readScopeEntries: scopeKey => planes().scopeIndex.read(scopeKey).entries.map(entry => ({
      id: entry.id,
      orderKey: entry.orderKey
    })),
    planScopePlacement: (scopeKey, ids, readRow) => {
      const entries = planes().scopeIndex.read(scopeKey).entries;
      const scopeName = scopeKey.slice(0, scopeKey.indexOf(`\0`));
      const sort = options.scopes?.[scopeName]?.sort;
      const pending = new Set(ids);
      if (!sort || sort === 'server-order') {
        const tail = entries.filter(entry => !pending.has(entry.id)).at(-1)?.orderKey;
        const keys = keysForSequence(ids.length, tail);
        return ids.map((id, index) => ({
          id,
          orderKey: keys[index]
        }));
      }
      const compare = compareRowsBySpec(sort);
      const anchors = [];
      for (const entry of entries) {
        if (pending.has(entry.id)) continue;
        const row = readRow(options.modelId, entry.id);
        if (row) anchors.push({
          orderKey: entry.orderKey,
          row
        });
      }
      const placements = [];
      for (const id of ids) {
        const row = readRow(options.modelId, id);
        if (!row) {
          placements.push({
            id,
            orderKey: keysForSequence(1, anchors.at(-1)?.orderKey)[0]
          });
          continue;
        }
        let lower = 0;
        let upper = anchors.length;
        while (lower < upper) {
          const middle = Math.floor((lower + upper) / 2);
          if (compare(anchors[middle].row, row) < 0) lower = middle + 1;else upper = middle;
        }
        const orderKey = keysForSequence(1, anchors[lower - 1]?.orderKey, anchors[lower]?.orderKey)[0];
        anchors.splice(lower, 0, {
          orderKey,
          row
        });
        placements.push({
          id,
          orderKey
        });
      }
      return placements;
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
      planes().scopeIndex.applyDelta(scopeKey, delta.append, delta.detach);
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