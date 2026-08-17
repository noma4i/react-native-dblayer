"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createScopePlane = void 0;
var _db = require("@tanstack/db");
var _serialize = require("./serialize.js");
var _diagnostics = require("./diagnostics.js");
var _storeSync = require("./storeSync.js");
var _storeDerivedCollections = require("./storeDerivedCollections.js");
const membershipKey = (scopeKey, entityId) => (0, _serialize.compositeKey)(scopeKey, entityId);
const createScopePlane = options => {
  const {
    modelId,
    storeId,
    entities,
    readCommitted,
    isReady
  } = options;
  const membershipFeed = new _storeSync.SyncFeed();
  const memberships = (0, _db.createCollection)({
    ..._storeSync.OWNED_COLLECTION_LIFETIME,
    id: `dblayer-${modelId}-memberships-${storeId}`,
    getKey: row => membershipKey(row.scopeKey, row.entityId),
    startSync: true,
    sync: {
      sync: membershipFeed.sync
    }
  });
  const membershipsByScope = memberships.createIndex(row => row.scopeKey, {
    indexType: _db.BasicIndex
  });
  const scopeCollections = (0, _storeDerivedCollections.createDerivedCollectionCache)('derivedCollections');
  const buildScopeCollection = scopeKey => (0, _db.createLiveQueryCollection)({
    ..._storeSync.OWNED_COLLECTION_LIFETIME,
    id: `dblayer-${modelId}-scope-${storeId}-${scopeKey}`,
    startSync: true,
    query: q => q.from({
      membership: memberships
    }).where(({
      membership
    }) => (0, _db.eq)(membership.scopeKey, scopeKey))
    // Inner join: a membership whose entity row is absent must be skipped, not emitted as a
    // row of undefined entity fields (the render then crashes on the missing id).
    .join({
      entity: entities
    }, ({
      membership,
      entity
    }) => (0, _db.eq)(membership.entityId, entity.id), 'inner').orderBy(({
      membership
    }) => membership.orderKey, {
      direction: 'asc',
      stringSort: 'lexical'
    }).select(({
      membership,
      entity
    }) => ({
      ...entity,
      orderKey: membership.orderKey
    })),
    getKey: row => row.$key
  });
  const scopeMembers = scopeKey => [...membershipsByScope.equalityLookup(scopeKey)].flatMap(key => {
    const row = memberships.get(key);
    return row ? [row] : [];
  });
  const writeMemberships = messages => {
    if (messages.length === 0) return;
    (0, _diagnostics.noteMembershipWrites)(messages.length);
    membershipFeed.start();
    for (const message of messages) membershipFeed.pushMessage(message);
    membershipFeed.finish();
  };

  /**
   * Project ready-made membership instructions in op order; the store never computes an order key.
   * Steps of one change see the rows as projected by the steps before them, not the pre-batch store.
   */
  const projectScopeChange = change => {
    const messages = [];
    // Batch-local view over the store: entityId -> orderKey, null = detached by an earlier step.
    const projected = new Map();
    const orderKeyOf = entityId => {
      const local = projected.get(entityId);
      if (local !== undefined) return local ?? undefined;
      return memberships.get(membershipKey(change.scopeKey, entityId))?.orderKey;
    };
    const currentIds = () => {
      const ids = new Set(scopeMembers(change.scopeKey).map(row => row.entityId));
      for (const [entityId, orderKey] of projected) {
        if (orderKey === null) ids.delete(entityId);else ids.add(entityId);
      }
      return [...ids];
    };
    const detach = entityId => {
      if (orderKeyOf(entityId) === undefined) return;
      messages.push({
        type: 'delete',
        key: membershipKey(change.scopeKey, entityId)
      });
      projected.set(entityId, null);
    };
    const upsert = entry => {
      const existing = orderKeyOf(entry.id);
      if (existing === entry.orderKey) return;
      messages.push({
        type: existing === undefined ? 'insert' : 'update',
        value: {
          scopeKey: change.scopeKey,
          entityId: entry.id,
          orderKey: entry.orderKey
        }
      });
      projected.set(entry.id, entry.orderKey);
    };
    for (const step of change.steps) {
      if ('entries' in step) {
        const nextIds = new Set(step.entries.map(entry => entry.id));
        for (const entityId of currentIds()) if (!nextIds.has(entityId)) detach(entityId);
        for (const entry of step.entries) upsert(entry);
        continue;
      }
      for (const entityId of step.detachIds) detach(entityId);
      for (const entry of step.upserts) upsert(entry);
    }
    writeMemberships(messages);
  };
  return {
    scopeCollection: scopeKey => ({
      toArray: () => {
        (0, _storeSync.assertStoreReadable)();
        if (!isReady()) return [];
        const existing = scopeCollections.peek(scopeKey);
        if (existing) {
          const joined = [...existing.toArray];
          (0, _diagnostics.noteMembershipMissingEntity)(scopeMembers(scopeKey).length - joined.length);
          return joined;
        }
        let misses = 0;
        const rows = scopeMembers(scopeKey).sort((left, right) => (0, _serialize.compareCodepoints)(left.orderKey, right.orderKey) || (0, _serialize.compareCodepoints)(left.entityId, right.entityId)).flatMap(membership => {
          const entity = readCommitted(membership.entityId);
          if (!entity) {
            misses += 1;
            return [];
          }
          return [{
            ...entity,
            orderKey: membership.orderKey
          }];
        });
        (0, _diagnostics.noteMembershipMissingEntity)(misses);
        return rows;
      },
      subscribe: listener => {
        const held = scopeCollections.acquire(scopeKey, () => buildScopeCollection(scopeKey));
        const delivery = (0, _storeSync.createStoreTransactionBatcher)(listener);
        const subscription = held.collection.subscribeChanges(changes => delivery.push(changes), {
          includeInitialState: false
        });
        return () => {
          delivery.dispose();
          subscription.unsubscribe();
          held.release();
        };
      }
    }),
    applyScopeChanges: changes => {
      for (const change of changes) projectScopeChange(change);
    },
    markReady: () => {
      membershipFeed.markReady();
    },
    reset: () => {
      membershipFeed.start();
      membershipFeed.truncate();
      membershipFeed.finish();
    },
    dispose: () => {
      scopeCollections.disposeAll();
    }
  };
};
exports.createScopePlane = createScopePlane;
//# sourceMappingURL=storeScopeCollections.js.map