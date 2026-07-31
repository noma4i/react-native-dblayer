"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createScopePlane = void 0;
var _db = require("@tanstack/db");
var _serialize = require("./serialize.js");
var _diagnostics = require("./diagnostics.js");
var _storeSync = require("./storeSync.js");
const membershipKey = (scopeKey, entityId) => (0, _serialize.compositeKey)(scopeKey, entityId);
let storeScopeCollectionCount = 0;
globalThis.__DBLAYER_STORE_SCOPE_COLLECTIONS__ = {
  count: () => storeScopeCollectionCount
};
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
  const scopeCollections = new Map();
  const buildScopeCollection = scopeKey => (0, _db.createLiveQueryCollection)({
    ..._storeSync.OWNED_COLLECTION_LIFETIME,
    id: `dblayer-${modelId}-scope-${storeId}-${scopeKey}`,
    startSync: true,
    query: q => q.from({
      membership: memberships
    }).where(({
      membership
    }) => (0, _db.eq)(membership.scopeKey, scopeKey)).join({
      entity: entities
    }, ({
      membership,
      entity
    }) => (0, _db.eq)(membership.entityId, entity.id)).orderBy(({
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
  const getScopeCollection = scopeKey => {
    const existing = scopeCollections.get(scopeKey);
    if (existing) return existing;
    const entry = {
      collection: buildScopeCollection(scopeKey),
      consumers: 0
    };
    scopeCollections.set(scopeKey, entry);
    storeScopeCollectionCount += 1;
    return entry;
  };
  const releaseScopeCollection = (scopeKey, entry) => {
    entry.consumers -= 1;
    if (entry.consumers !== 0 || scopeCollections.get(scopeKey) !== entry) return;
    scopeCollections.delete(scopeKey);
    storeScopeCollectionCount -= 1;
    void entry.collection.cleanup();
  };
  const scopeMembers = scopeKey => [...membershipsByScope.equalityLookup(scopeKey)].map(key => memberships.get(key));
  const writeMemberships = messages => {
    if (messages.length === 0) return;
    (0, _diagnostics.noteMembershipWrites)(messages.length);
    membershipFeed.start();
    for (const message of messages) membershipFeed.pushMessage(message);
    membershipFeed.finish();
  };

  /** Project ready-made membership instructions; the store never computes an order key. */
  const projectScopeChange = change => {
    const messages = [];
    if (change.entries) {
      const current = new Map(scopeMembers(change.scopeKey).map(row => [row.entityId, row.orderKey]));
      const nextIds = new Set(change.entries.map(entry => entry.id));
      for (const [entityId] of current) {
        if (!nextIds.has(entityId)) messages.push({
          type: 'delete',
          key: membershipKey(change.scopeKey, entityId)
        });
      }
      for (const entry of change.entries) {
        const existing = current.get(entry.id);
        if (existing === entry.orderKey) continue;
        messages.push({
          type: existing === undefined ? 'insert' : 'update',
          value: {
            scopeKey: change.scopeKey,
            entityId: entry.id,
            orderKey: entry.orderKey
          }
        });
      }
    }
    for (const entityId of change.detachIds ?? []) {
      if (memberships.has(membershipKey(change.scopeKey, entityId))) messages.push({
        type: 'delete',
        key: membershipKey(change.scopeKey, entityId)
      });
    }
    for (const entry of change.upserts ?? []) {
      const key = membershipKey(change.scopeKey, entry.id);
      const existing = memberships.get(key);
      if (existing?.orderKey === entry.orderKey) continue;
      messages.push({
        type: existing === undefined ? 'insert' : 'update',
        value: {
          scopeKey: change.scopeKey,
          entityId: entry.id,
          orderKey: entry.orderKey
        }
      });
    }
    writeMemberships(messages);
  };
  return {
    scopeCollection: scopeKey => ({
      toArray: () => {
        (0, _storeSync.assertStoreReadable)();
        if (!isReady()) return [];
        const existing = scopeCollections.get(scopeKey);
        if (existing) return [...existing.collection.toArray];
        return scopeMembers(scopeKey).sort((left, right) => (0, _serialize.compareCodepoints)(left.orderKey, right.orderKey) || (0, _serialize.compareCodepoints)(left.entityId, right.entityId)).flatMap(membership => {
          const entity = readCommitted(membership.entityId);
          return entity ? [{
            ...entity,
            orderKey: membership.orderKey
          }] : [];
        });
      },
      subscribe: listener => {
        const entry = getScopeCollection(scopeKey);
        entry.consumers += 1;
        let released = false;
        let scheduled = false;
        let pending = [];
        const subscription = entry.collection.subscribeChanges(changes => {
          const next = changes;
          if (!(0, _storeSync.isInStoreTransaction)()) {
            listener(next);
            return;
          }
          pending.push(...next);
          if (scheduled) return;
          scheduled = true;
          (0, _storeSync.afterStoreTransaction)(() => {
            scheduled = false;
            const batch = pending;
            pending = [];
            if (!released && batch.length > 0) listener(batch);
          });
        }, {
          includeInitialState: false
        });
        return () => {
          released = true;
          pending = [];
          subscription.unsubscribe();
          releaseScopeCollection(scopeKey, entry);
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
      for (const entry of scopeCollections.values()) void entry.collection.cleanup();
      storeScopeCollectionCount -= scopeCollections.size;
      scopeCollections.clear();
    }
  };
};
exports.createScopePlane = createScopePlane;
//# sourceMappingURL=storeScopeCollections.js.map