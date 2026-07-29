"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createModelApplyTarget = void 0;
var _applyTargetRegistry = require("../core/apply/applyTargetRegistry.js");
var _commitEnvelope = require("../core/apply/commitEnvelope.js");
var _orderKey = require("../core/orderKey.js");
var _serialize = require("../core/serialize.js");
var _configure = require("./configure.js");
var _ordering = require("../core/ordering.js");
const createModelApplyTarget = options => {
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
      const scopeName = (0, _serialize.firstCompositeKeyPart)(scopeKey);
      const sort = options.scopes?.[scopeName]?.sort;
      const pending = new Set(ids);
      if (!sort || sort === 'server-order') {
        const tail = entries.filter(entry => !pending.has(entry.id)).at(-1)?.orderKey;
        const keys = (0, _orderKey.keysForSequence)(ids.length, tail);
        return ids.map((id, index) => ({
          id,
          orderKey: keys[index]
        }));
      }
      const compare = (0, _ordering.compareRowsBySpec)(sort);
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
      const unresolved = [];
      for (const id of ids) {
        const row = readRow(options.modelId, id);
        if (!row) {
          unresolved.push(id);
          continue;
        }
        let lower = 0;
        let upper = anchors.length;
        while (lower < upper) {
          const middle = Math.floor((lower + upper) / 2);
          if (compare(anchors[middle].row, row) < 0) lower = middle + 1;else upper = middle;
        }
        const orderKey = (0, _orderKey.keysForSequence)(1, anchors[lower - 1]?.orderKey, anchors[lower]?.orderKey)[0];
        anchors.splice(lower, 0, {
          orderKey,
          row
        });
        placements.push({
          id,
          orderKey
        });
      }
      const unresolvedKeys = (0, _orderKey.keysForSequence)(unresolved.length, anchors.at(-1)?.orderKey);
      unresolved.forEach((id, index) => placements.push({
        id,
        orderKey: unresolvedKeys[index]
      }));
      return placements;
    },
    readScopeOrderRevision: scopeKey => planes().scopeIndex.orderRevision(scopeKey),
    readScopeGeneration: scopeKey => planes().scopeIndex.read(scopeKey).generation,
    scopeOrderAffected: (scopeKey, id, fields) => {
      if (fields === null || !planes().scopeIndex.has(scopeKey, id)) return true;
      const scopeName = (0, _serialize.firstCompositeKeyPart)(scopeKey);
      const spec = options.scopes?.[scopeName];
      if (!spec) return false;
      const relevant = new Set(spec.by ? Object.values(spec.by) : []);
      if (spec.sort && spec.sort !== 'server-order') {
        if ((0, _ordering.isMultiFieldSort)(spec.sort)) for (const order of spec.sort) relevant.add(String(order.field));else if ('field' in spec.sort) relevant.add(String(spec.sort.field));else {
          if (spec.sort.orderFields === undefined) return true;
          for (const field of spec.sort.orderFields) relevant.add(field);
        }
      }
      return fields.some(field => relevant.has(field));
    },
    scopeSortMeta: scopeKey => {
      const scopeName = (0, _serialize.firstCompositeKeyPart)(scopeKey);
      const sort = options.scopes?.[scopeName]?.sort;
      if (!sort || sort === 'server-order') return {
        kind: 'server-order'
      };
      if ((0, _ordering.isMultiFieldSort)(sort)) return {
        kind: 'fields',
        fields: sort.map(order => ({
          field: String(order.field),
          dir: order.dir
        }))
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
    beginApply: () => {
      planes().scopeIndex.beginApply();
    },
    commitApply: () => {
      planes().scopeIndex.commitApply();
    },
    abortApply: () => {
      planes().scopeIndex.abortApply();
    },
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
  (0, _applyTargetRegistry.registerApplyTarget)(options.modelId, applyTarget);
  const applySnapshot = ops => {
    (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)(ops));
  };
  const applyEvent = ops => {
    (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)(ops.map(op => op.kind === 'upsert' && op.origin === undefined ? {
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
exports.createModelApplyTarget = createModelApplyTarget;
//# sourceMappingURL=modelApplyTarget.js.map