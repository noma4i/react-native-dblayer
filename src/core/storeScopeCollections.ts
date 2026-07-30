import { BasicIndex, createCollection, createLiveQueryCollection, eq, type ChangeMessageOrDeleteKeyMessage } from '@tanstack/db';
import { compareCodepoints, compositeKey } from './serialize';
import { noteMembershipWrites } from './diagnostics';
import type { ScopePlane, ScopePlaneOptions, StoreMembershipRow, StoreScopeChange, StoreScopeSyncChange } from '../types';
import { SyncFeed, assertStoreReadable } from './storeSync';

const membershipKey = (scopeKey: string, entityId: string): string => compositeKey(scopeKey, entityId);

let storeScopeCollectionCount = 0;

(globalThis as Record<string, unknown>).__DBLAYER_STORE_SCOPE_COLLECTIONS__ = {
  count: (): number => storeScopeCollectionCount
};

export const createScopePlane = (options: ScopePlaneOptions): ScopePlane => {
  const { modelId, storeId, entities, readCommitted, isReady } = options;
  const membershipFeed = new SyncFeed<StoreMembershipRow>();
  const memberships = createCollection<StoreMembershipRow>({
    id: `dblayer-${modelId}-memberships-${storeId}`,
    getKey: row => membershipKey(row.scopeKey, row.entityId),
    startSync: true,
    sync: { sync: membershipFeed.sync }
  });
  const membershipsByScope = memberships.createIndex(row => row.scopeKey, { indexType: BasicIndex });

  const scopeCollections = new Map<string, { collection: ReturnType<typeof buildScopeCollection>; consumers: number }>();
  const buildScopeCollection = (scopeKey: string) =>
    createLiveQueryCollection({
      id: `dblayer-${modelId}-scope-${storeId}-${scopeKey}`,
      startSync: true,
      query: q =>
        q
          .from({ membership: memberships })
          .where(({ membership }) => eq(membership.scopeKey, scopeKey))
          .join({ entity: entities }, ({ membership, entity }) => eq(membership.entityId, entity.id))
          .orderBy(({ membership }) => membership.orderKey, { direction: 'asc', stringSort: 'lexical' })
          .select(({ membership, entity }) => ({ ...entity, orderKey: membership.orderKey })),
      getKey: row => row.$key
    });

  const getScopeCollection = (scopeKey: string) => {
    const existing = scopeCollections.get(scopeKey);
    if (existing) return existing;
    const entry = { collection: buildScopeCollection(scopeKey), consumers: 0 };
    scopeCollections.set(scopeKey, entry);
    storeScopeCollectionCount += 1;
    return entry;
  };

  const releaseScopeCollection = (scopeKey: string, entry: { collection: ReturnType<typeof buildScopeCollection>; consumers: number }): void => {
    entry.consumers -= 1;
    if (entry.consumers !== 0 || scopeCollections.get(scopeKey) !== entry) return;
    scopeCollections.delete(scopeKey);
    storeScopeCollectionCount -= 1;
    void entry.collection.cleanup();
  };

  const scopeMembers = (scopeKey: string): StoreMembershipRow[] =>
    [...membershipsByScope.equalityLookup(scopeKey)].flatMap(key => {
      if (typeof key !== 'string') return [];
      const row = memberships.get(key);
      return row ? [row] : [];
    });

  const writeMemberships = (messages: ReadonlyArray<ChangeMessageOrDeleteKeyMessage<StoreMembershipRow, string>>): void => {
    if (messages.length === 0) return;
    noteMembershipWrites(messages.length);
    membershipFeed.start();
    for (const message of messages) membershipFeed.pushMessage(message);
    membershipFeed.finish();
  };

  /** Project ready-made membership instructions; the store never computes an order key. */
  const projectScopeChange = (change: StoreScopeSyncChange): void => {
    const messages: Array<ChangeMessageOrDeleteKeyMessage<StoreMembershipRow, string>> = [];
    if (change.entries) {
      const current = new Map(scopeMembers(change.scopeKey).map(row => [row.entityId, row.orderKey] as const));
      const nextIds = new Set(change.entries.map(entry => entry.id));
      for (const [entityId] of current) {
        if (!nextIds.has(entityId)) messages.push({ type: 'delete', key: membershipKey(change.scopeKey, entityId) });
      }
      for (const entry of change.entries) {
        const existing = current.get(entry.id);
        if (existing === entry.orderKey) continue;
        messages.push({ type: existing === undefined ? 'insert' : 'update', value: { scopeKey: change.scopeKey, entityId: entry.id, orderKey: entry.orderKey } });
      }
    }
    for (const entityId of change.detachIds ?? []) {
      if (memberships.has(membershipKey(change.scopeKey, entityId))) messages.push({ type: 'delete', key: membershipKey(change.scopeKey, entityId) });
    }
    for (const entry of change.upserts ?? []) {
      const key = membershipKey(change.scopeKey, entry.id);
      const existing = memberships.get(key);
      if (existing?.orderKey === entry.orderKey) continue;
      messages.push({ type: existing === undefined ? 'insert' : 'update', value: { scopeKey: change.scopeKey, entityId: entry.id, orderKey: entry.orderKey } });
    }
    writeMemberships(messages);
  };

  return {
    scopeCollection: scopeKey => ({
      toArray: () => {
        assertStoreReadable();
        if (!isReady()) return [];
        const existing = scopeCollections.get(scopeKey);
        if (existing) return [...existing.collection.toArray];
        return scopeMembers(scopeKey)
          .sort((left, right) => compareCodepoints(left.orderKey, right.orderKey) || compareCodepoints(left.entityId, right.entityId))
          .flatMap(membership => {
            const entity = readCommitted(membership.entityId);
            return entity ? [{ ...entity, orderKey: membership.orderKey }] : [];
          });
      },
      subscribe: listener => {
        const entry = getScopeCollection(scopeKey);
        entry.consumers += 1;
        const subscription = entry.collection.subscribeChanges(changes => listener(changes as StoreScopeChange[]), { includeInitialState: false });
        return () => {
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
