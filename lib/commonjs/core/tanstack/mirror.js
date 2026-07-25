"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.seedCollections = seedCollections;
exports.startCollectionMirror = startCollectionMirror;
var _transaction = require("../apply/transaction.js");
var _facade = require("./facade.js");
var _reset = require("../reset.js");
var _esToolkit = require("es-toolkit");
var _useLiveRead = require("../../read/useLiveRead.js");
var _diagnostics = require("../diagnostics.js");
var _serialize = require("../serialize.js");
const rowsDiffer = (current, next) => !(0, _useLiveRead.rowsShallowEqual)(current, next);
const scopeOrderCache = new Map();
// Reset contract: clear cross-generation order-revision cache so a post-reset scope never matches a stale revision.
(0, _reset.registerReset)(() => scopeOrderCache.clear());

/** Starts synchronously mirroring every commit-bus row batch into TanStack model collections. */
function startCollectionMirror(bus) {
  return bus.subscribeAll(batch => {
    (0, _diagnostics.noteCommit)();
    const rowIdsByModel = new Map();
    const scopeKeysByModel = new Map();
    for (const row of batch.rows) {
      const rowIds = rowIdsByModel.get(row.model) ?? new Set();
      rowIds.add(row.id);
      rowIdsByModel.set(row.model, rowIds);
    }
    for (const change of batch.scopeChanges ?? []) {
      const scopeKeys = scopeKeysByModel.get(change.model) ?? new Set();
      scopeKeys.add(change.scopeKey);
      scopeKeysByModel.set(change.model, scopeKeys);
    }
    for (const change of batch.scopes) {
      const scopeKeys = scopeKeysByModel.get(change.model) ?? new Set();
      scopeKeys.add(change.scopeKey);
      scopeKeysByModel.set(change.model, scopeKeys);
    }
    const scopeChangesByKey = new Map();
    for (const change of batch.scopeChanges ?? []) {
      const key = (0, _serialize.compositeKey)(change.model, change.scopeKey);
      const group = scopeChangesByKey.get(key) ?? [];
      group.push(change);
      scopeChangesByKey.set(key, group);
    }
    (0, _facade.runInWriteBatch)(() => {
      for (const modelId of new Set([...rowIdsByModel.keys(), ...scopeKeysByModel.keys()])) {
        let target;
        try {
          target = (0, _transaction.getApplyTarget)(modelId);
        } catch {
          continue;
        }
        const rowIds = rowIdsByModel.get(modelId) ?? new Set();
        const collection = (0, _facade.ensureModelCollection)(modelId);
        const writer = (0, _facade.writerFor)(modelId);
        writer.begin();
        for (const id of rowIds) {
          const row = target.readRow(id);
          const current = collection.get(id);
          if (!row) {
            if (current) writer.write({
              type: 'delete',
              key: id
            });
            continue;
          }
          const next = {
            ...row,
            id
          };
          if (!current) {
            writer.write({
              type: 'insert',
              value: next
            });
            continue;
          }
          if (rowsDiffer(current, next)) {
            writer.write({
              type: 'update',
              value: next
            });
          }
        }
        writer.commit();
        const scopeKeys = scopeKeysByModel.get(modelId) ?? new Set();
        if (scopeKeys.size === 0) continue;
        const memberships = (0, _facade.ensureMembershipCollection)(modelId);
        const membershipWriter = (0, _facade.membershipWriterFor)(modelId);
        membershipWriter.begin();
        for (const scopeKey of scopeKeys) {
          const scopeStartedAt = globalThis.performance?.now?.() ?? Date.now();
          let resorted = false;
          const scopeChanges = scopeChangesByKey.get((0, _serialize.compositeKey)(modelId, scopeKey)) ?? [];
          const structural = scopeChanges.reduce((current, change) => ({
            appendIds: (0, _esToolkit.uniq)([...current.appendIds, ...(change.appendIds ?? [])]),
            appendEntries: (0, _esToolkit.uniqBy)([...(change.appendEntries ?? []), ...current.appendEntries], entry => entry.id),
            detachIds: (0, _esToolkit.uniq)([...current.detachIds, ...(change.detachIds ?? [])]),
            rebuild: current.rebuild || change.rebuild === true
          }), {
            appendIds: [],
            appendEntries: [],
            detachIds: [],
            rebuild: false
          });
          const meta = target.scopeSortMeta(scopeKey);
          if (meta.kind === 'field') {
            if (structural.rebuild) {
              resorted = true;
              const existing = memberships.toArray.filter(row => row.scopeKey === scopeKey);
              const expected = target.readScopeOrder(scopeKey).flatMap(rowId => {
                const row = target.readRow(rowId);
                return row ? [{
                  key: (0, _serialize.compositeKey)(scopeKey, rowId),
                  scopeKey,
                  rowId,
                  sortValue: row[meta.field]
                }] : [];
              });
              const expectedKeys = new Set(expected.map(row => row.key));
              for (const row of existing) if (!expectedKeys.has(row.key)) membershipWriter.write({
                type: 'delete',
                key: row.key
              });
              for (const row of expected) {
                const current = memberships.get(row.key);
                if (!current) membershipWriter.write({
                  type: 'insert',
                  value: row
                });else if (rowsDiffer(current, row)) membershipWriter.write({
                  type: 'update',
                  value: row
                });
              }
            } else {
              for (const rowId of structural.detachIds) membershipWriter.write({
                type: 'delete',
                key: (0, _serialize.compositeKey)(scopeKey, rowId)
              });
              for (const rowId of structural.appendIds) {
                const row = target.readRow(rowId);
                if (!row) continue;
                const next = {
                  key: (0, _serialize.compositeKey)(scopeKey, rowId),
                  scopeKey,
                  rowId,
                  sortValue: row[meta.field]
                };
                const current = memberships.get(next.key);
                if (!current) membershipWriter.write({
                  type: 'insert',
                  value: next
                });else if (rowsDiffer(current, next)) membershipWriter.write({
                  type: 'update',
                  value: next
                });
              }
            }
            for (const change of batch.rows) {
              if (change.model !== modelId || !change.fields?.includes(meta.field)) continue;
              const key = (0, _serialize.compositeKey)(scopeKey, change.id);
              const current = memberships.get(key);
              const row = target.readRow(change.id);
              if (!current || !row) continue;
              const next = {
                key,
                scopeKey,
                rowId: change.id,
                sortValue: row[meta.field]
              };
              if (rowsDiffer(current, next)) membershipWriter.write({
                type: 'update',
                value: next
              });
            }
            (0, _diagnostics.noteMirrorScopePass)(resorted, (globalThis.performance?.now?.() ?? Date.now()) - scopeStartedAt);
            continue;
          }
          if (meta.kind === 'server-order' && !structural.rebuild && structural.appendIds.length === 0 && structural.detachIds.length === 0) {
            (0, _diagnostics.noteMirrorScopePass)(false, (globalThis.performance?.now?.() ?? Date.now()) - scopeStartedAt);
            continue;
          }
          const revision = target.readScopeOrderRevision(scopeKey);
          const modelCache = scopeOrderCache.get(modelId) ?? new Map();
          scopeOrderCache.set(modelId, modelCache);
          if (meta.kind === 'server-order' && !structural.rebuild) {
            const appendOrders = new Map(structural.appendEntries.map(entry => [entry.id, entry.order]));
            if (structural.appendIds.every(rowId => appendOrders.has(rowId))) {
              for (const rowId of structural.detachIds) membershipWriter.write({
                type: 'delete',
                key: (0, _serialize.compositeKey)(scopeKey, rowId)
              });
              for (const rowId of structural.appendIds) {
                const order = appendOrders.get(rowId);
                const next = {
                  key: (0, _serialize.compositeKey)(scopeKey, rowId),
                  scopeKey,
                  rowId,
                  seq: order
                };
                const current = memberships.get(next.key);
                if (!current) membershipWriter.write({
                  type: 'insert',
                  value: next
                });else if (rowsDiffer(current, next)) membershipWriter.write({
                  type: 'update',
                  value: next
                });
              }
              modelCache.set(scopeKey, revision);
              (0, _diagnostics.noteMirrorScopePass)(false, (globalThis.performance?.now?.() ?? Date.now()) - scopeStartedAt);
              continue;
            }
          }
          const orderAffected = batch.rows.some(row => row.model === modelId && target.scopeOrderAffected(scopeKey, row.id, row.fields));
          if (meta.kind === 'comparator' && !structural.rebuild && structural.appendIds.length === 0 && structural.detachIds.length === 0 && modelCache.get(scopeKey) === revision && !orderAffected) {
            (0, _diagnostics.noteMirrorScopePass)(false, (globalThis.performance?.now?.() ?? Date.now()) - scopeStartedAt);
            continue;
          }
          resorted = true;
          const expected = meta.kind === 'comparator' ? target.readScopeOrder(scopeKey).map((rowId, seq) => ({
            key: (0, _serialize.compositeKey)(scopeKey, rowId),
            scopeKey,
            rowId,
            seq
          })) : target.readScopeEntries(scopeKey).map(entry => ({
            key: (0, _serialize.compositeKey)(scopeKey, entry.id),
            scopeKey,
            rowId: entry.id,
            seq: entry.order
          }));
          const expectedKeys = new Set(expected.map(row => row.key));
          const existing = memberships.toArray.filter(row => row.scopeKey === scopeKey);
          for (const row of existing) if (!expectedKeys.has(row.key)) membershipWriter.write({
            type: 'delete',
            key: row.key
          });
          for (const row of expected) {
            const current = memberships.get(row.key);
            if (!current) membershipWriter.write({
              type: 'insert',
              value: row
            });else if (rowsDiffer(current, row)) membershipWriter.write({
              type: 'update',
              value: row
            });
          }
          modelCache.set(scopeKey, revision);
          (0, _diagnostics.noteMirrorScopePass)(resorted, (globalThis.performance?.now?.() ?? Date.now()) - scopeStartedAt);
        }
        membershipWriter.commit();
      }
    });
  });
}

/** Seeds model collections from their visible EntityState rows after hydration. */
function seedCollections(models) {
  (0, _facade.runInWriteBatch)(() => {
    for (const modelId of models) {
      let target;
      try {
        target = (0, _transaction.getApplyTarget)(modelId);
      } catch {
        continue;
      }
      const collection = (0, _facade.ensureModelCollection)(modelId);
      const writer = (0, _facade.writerFor)(modelId);
      writer.begin();
      for (const row of target.readAllRows()) {
        const id = String(row.id);
        const current = collection.get(id);
        const next = {
          ...row,
          id
        };
        if (!current) {
          writer.write({
            type: 'insert',
            value: next
          });
          continue;
        }
        if (rowsDiffer(current, next)) {
          writer.write({
            type: 'update',
            value: next
          });
        }
      }
      writer.commit();
      const memberships = (0, _facade.ensureMembershipCollection)(modelId);
      const membershipWriter = (0, _facade.membershipWriterFor)(modelId);
      membershipWriter.begin();
      for (const scopeKey of target.readAllScopeKeys()) {
        const meta = target.scopeSortMeta(scopeKey);
        const expected = meta.kind === 'field' ? target.readScopeOrder(scopeKey).flatMap(rowId => {
          const row = target.readRow(rowId);
          return row ? [{
            key: (0, _serialize.compositeKey)(scopeKey, rowId),
            scopeKey,
            rowId,
            sortValue: row[meta.field]
          }] : [];
        }) : meta.kind === 'comparator' ? target.readScopeOrder(scopeKey).flatMap((rowId, seq) => {
          const row = target.readRow(rowId);
          return row ? [{
            key: (0, _serialize.compositeKey)(scopeKey, rowId),
            scopeKey,
            rowId,
            seq
          }] : [];
        }) : target.readScopeEntries(scopeKey).flatMap(entry => {
          const row = target.readRow(entry.id);
          return row ? [{
            key: (0, _serialize.compositeKey)(scopeKey, entry.id),
            scopeKey,
            rowId: entry.id,
            seq: entry.order
          }] : [];
        });
        const existing = memberships.toArray.filter(row => row.scopeKey === scopeKey);
        const expectedKeys = new Set(expected.map(row => row.key));
        for (const row of existing) if (!expectedKeys.has(row.key)) membershipWriter.write({
          type: 'delete',
          key: row.key
        });
        for (const row of expected) {
          const current = memberships.get(row.key);
          if (!current) membershipWriter.write({
            type: 'insert',
            value: row
          });else if (rowsDiffer(current, row)) membershipWriter.write({
            type: 'update',
            value: row
          });
        }
        const modelCache = scopeOrderCache.get(modelId) ?? new Map();
        scopeOrderCache.set(modelId, modelCache);
        modelCache.set(scopeKey, target.readScopeOrderRevision(scopeKey));
      }
      membershipWriter.commit();
    }
  });
}
//# sourceMappingURL=mirror.js.map