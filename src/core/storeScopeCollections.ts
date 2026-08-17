import { BasicIndex, createCollection, createLiveQueryCollection, eq, type ChangeMessageOrDeleteKeyMessage } from '@tanstack/db';
import { compareCodepoints, compositeKey } from './serialize';
import { noteMembershipMissingEntity, noteMembershipWrites } from './diagnostics';
import type { ScopePlane, ScopePlaneOptions, StoreMembershipRow, StoreScopeChange, StoreScopeSyncChange } from '../types';
import { createStoreTransactionBatcher, OWNED_COLLECTION_LIFETIME, SyncFeed, assertStoreReadable } from './storeSync';
import { createDerivedCollectionCache } from './storeDerivedCollections';

const membershipKey = (scopeKey: string, entityId: string): string => compositeKey(scopeKey, entityId);

export const createScopePlane = (options: ScopePlaneOptions): ScopePlane => {
  const { modelId, storeId, entities, readCommitted, isReady } = options;
  const membershipFeed = new SyncFeed<StoreMembershipRow>();
  const memberships = createCollection<StoreMembershipRow>({
    ...OWNED_COLLECTION_LIFETIME,
    id: `dblayer-${modelId}-memberships-${storeId}`,
    getKey: row => membershipKey(row.scopeKey, row.entityId),
    startSync: true,
    sync: { sync: membershipFeed.sync }
  });
  const membershipsByScope = memberships.createIndex(row => row.scopeKey, { indexType: BasicIndex });

  const scopeCollections = createDerivedCollectionCache<ReturnType<typeof buildScopeCollection>>('derivedCollections');
  const buildScopeCollection = (scopeKey: string) =>
    createLiveQueryCollection({
      ...OWNED_COLLECTION_LIFETIME,
      id: `dblayer-${modelId}-scope-${storeId}-${scopeKey}`,
      startSync: true,
      query: q =>
        q
          .from({ membership: memberships })
          .where(({ membership }) => eq(membership.scopeKey, scopeKey))
          // Inner join: a membership whose entity row is absent must be skipped, not emitted as a
          // row of undefined entity fields (the render then crashes on the missing id).
          .join({ entity: entities }, ({ membership, entity }) => eq(membership.entityId, entity.id), 'inner')
          .orderBy(({ membership }) => membership.orderKey, { direction: 'asc', stringSort: 'lexical' })
          .select(({ membership, entity }) => ({ ...entity, orderKey: membership.orderKey })),
      getKey: row => row.$key
    });

  const scopeMembers = (scopeKey: string): StoreMembershipRow[] =>
    [...membershipsByScope.equalityLookup(scopeKey)].flatMap(key => {
      const row = memberships.get(key as string);
      return row ? [row] : [];
    });

  const writeMemberships = (messages: ReadonlyArray<ChangeMessageOrDeleteKeyMessage<StoreMembershipRow, string>>): void => {
    if (messages.length === 0) return;
    noteMembershipWrites(messages.length);
    membershipFeed.start();
    for (const message of messages) membershipFeed.pushMessage(message);
    membershipFeed.finish();
  };

  /**
   * Project ready-made membership instructions in op order; the store never computes an order key.
   * Steps of one change see the rows as projected by the steps before them, not the pre-batch store.
   */
  const projectScopeChange = (change: StoreScopeSyncChange): void => {
    const messages: Array<ChangeMessageOrDeleteKeyMessage<StoreMembershipRow, string>> = [];
    // Batch-local view over the store: entityId -> orderKey, null = detached by an earlier step.
    const projected = new Map<string, string | null>();
    const orderKeyOf = (entityId: string): string | undefined => {
      const local = projected.get(entityId);
      if (local !== undefined) return local ?? undefined;
      return memberships.get(membershipKey(change.scopeKey, entityId))?.orderKey;
    };
    const currentIds = (): string[] => {
      const ids = new Set(scopeMembers(change.scopeKey).map(row => row.entityId));
      for (const [entityId, orderKey] of projected) {
        if (orderKey === null) ids.delete(entityId);
        else ids.add(entityId);
      }
      return [...ids];
    };
    const detach = (entityId: string): void => {
      if (orderKeyOf(entityId) === undefined) return;
      messages.push({ type: 'delete', key: membershipKey(change.scopeKey, entityId) });
      projected.set(entityId, null);
    };
    const upsert = (entry: { id: string; orderKey: string }): void => {
      const existing = orderKeyOf(entry.id);
      if (existing === entry.orderKey) return;
      messages.push({ type: existing === undefined ? 'insert' : 'update', value: { scopeKey: change.scopeKey, entityId: entry.id, orderKey: entry.orderKey } });
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
        assertStoreReadable();
        if (!isReady()) return [];
        const existing = scopeCollections.peek(scopeKey);
        if (existing) {
          const joined = [...existing.toArray];
          noteMembershipMissingEntity(scopeMembers(scopeKey).length - joined.length);
          return joined;
        }
        let misses = 0;
        const rows = scopeMembers(scopeKey)
          .sort((left, right) => compareCodepoints(left.orderKey, right.orderKey) || compareCodepoints(left.entityId, right.entityId))
          .flatMap(membership => {
            const entity = readCommitted(membership.entityId);
            if (!entity) {
              misses += 1;
              return [];
            }
            return [{ ...entity, orderKey: membership.orderKey }];
          });
        noteMembershipMissingEntity(misses);
        return rows;
      },
      subscribe: listener => {
        const held = scopeCollections.acquire(scopeKey, () => buildScopeCollection(scopeKey));
        const delivery = createStoreTransactionBatcher<StoreScopeChange>(listener);
        const subscription = held.collection.subscribeChanges(
          changes => delivery.push(changes as StoreScopeChange[]),
          { includeInitialState: false }
        );
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
