"use strict";

import { BasicIndex, createCollection, createLiveQueryCollection, eq } from '@tanstack/db';
import { compareCodepoints, compositeKey } from "./serialize.js";
import { noteMembershipMissingEntity, noteMembershipWrites } from "./diagnostics.js";
import { createStoreTransactionBatcher, OWNED_COLLECTION_LIFETIME, SyncFeed, assertStoreReadable } from "./storeSync.js";
import { createDerivedCollectionCache } from "./storeDerivedCollections.js";
const membershipKey = (scopeKey, entityId) => compositeKey(scopeKey, entityId);
export const createScopePlane = options => {
  const {
    modelId,
    storeId,
    entities,
    readCommitted,
    isReady
  } = options;
  const membershipFeed = new SyncFeed();
  const memberships = createCollection({
    ...OWNED_COLLECTION_LIFETIME,
    id: `dblayer-${modelId}-memberships-${storeId}`,
    getKey: row => membershipKey(row.scopeKey, row.entityId),
    startSync: true,
    sync: {
      sync: membershipFeed.sync
    }
  });
  const membershipsByScope = memberships.createIndex(row => row.scopeKey, {
    indexType: BasicIndex
  });
  const scopeCollections = createDerivedCollectionCache();
  const buildScopeCollection = scopeKey => createLiveQueryCollection({
    ...OWNED_COLLECTION_LIFETIME,
    id: `dblayer-${modelId}-scope-${storeId}-${scopeKey}`,
    startSync: true,
    query: q => q.from({
      membership: memberships
    }).where(({
      membership
    }) => eq(membership.scopeKey, scopeKey))
    // Inner join: a membership whose entity row is absent must be skipped, not emitted as a
    // row of undefined entity fields (the render then crashes on the missing id).
    .join({
      entity: entities
    }, ({
      membership,
      entity
    }) => eq(membership.entityId, entity.id), 'inner').orderBy(({
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
    noteMembershipWrites(messages.length);
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
        assertStoreReadable();
        if (!isReady()) return [];
        const existing = scopeCollections.peek(scopeKey);
        if (existing) {
          const joined = [...existing.toArray];
          noteMembershipMissingEntity(scopeMembers(scopeKey).length - joined.length);
          return joined;
        }
        let misses = 0;
        const rows = scopeMembers(scopeKey).sort((left, right) => compareCodepoints(left.orderKey, right.orderKey) || compareCodepoints(left.entityId, right.entityId)).flatMap(membership => {
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
        noteMembershipMissingEntity(misses);
        return rows;
      },
      subscribe: listener => {
        const held = scopeCollections.acquire(scopeKey, () => buildScopeCollection(scopeKey));
        const delivery = createStoreTransactionBatcher(listener);
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
//# sourceMappingURL=storeScopeCollections.js.map