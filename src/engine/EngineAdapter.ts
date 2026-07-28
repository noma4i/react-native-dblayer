import { BasicIndex, createCollection, createLiveQueryCollection, eq, type ChangeMessageOrDeleteKeyMessage, type Collection } from '@tanstack/db';
import type { EngineAdapter, EngineEntityChange, EngineEntityRow, EngineMembershipChange, EngineMembershipRow, EngineScopeChange, EngineScopeCollection, EngineScopeRow } from '../types';

type SyncMethods<T extends object> = {
  begin: () => void;
  write: (message: ChangeMessageOrDeleteKeyMessage<T, string>) => void;
  commit: () => void;
  markReady: () => void;
};
type EngineApplyTarget = {
  readRow(id: string): Record<string, unknown> | undefined;
  readAllRows(): Array<Record<string, unknown>>;
  readScopeOrder(scopeKey: string): string[];
  readAllScopeKeys(): string[];
  scopeOrderAffected(scopeKey: string, id: string, fields: string[] | null): boolean;
};
type EngineBatch = {
  rows: Array<{ model: string; id: string; fields: string[] | null; kind?: 'upsert' | 'destroy' }>;
  scopes: Array<{ model: string; scopeKey: string }>;
  scopeChanges?: Array<{ model: string; scopeKey: string; ids?: string[]; appendIds?: string[]; appendEntries?: Array<{ id: string; order: number }>; detachIds?: string[]; rebuild?: boolean }>;
};
type EngineScopeDelta = NonNullable<EngineBatch['scopeChanges']>[number];

type LiveScopeCollection = Pick<Collection<EngineScopeRow, string | number>, 'toArray' | 'subscribeChanges' | 'cleanup'> & {
  subscribeChanges(callback: (changes: EngineScopeChange[]) => void, options: { includeInitialState: boolean }): { unsubscribe(): void };
};


type EngineAdapterOptions = {
  onPhase?: (name: 'entities' | 'memberships', current: EngineAdapter) => void;
  onMembershipWrite?: (kind: 'delta' | 'rebuild', changes: readonly EngineMembershipChange[]) => void;
};

class SyncFeed<T extends object> {
  private methods: SyncMethods<T> | null = null;

  sync = (methods: SyncMethods<T>): (() => void) => {
    this.methods = methods;
    return () => {
      if (this.methods === methods) this.methods = null;
    };
  };

  push(messages: readonly ChangeMessageOrDeleteKeyMessage<T, string>[]): void {
    this.start();
    for (const message of messages) this.pushMessage(message);
    this.finish();
  }

  start(): void {
    this.requireMethods().begin();
  }

  pushMessage(message: ChangeMessageOrDeleteKeyMessage<T, string>): void {
    this.requireMethods().write(message);
  }

  finish(): void {
    this.requireMethods().commit();
  }

  markReady(): void {
    this.requireMethods().markReady();
  }

  private requireMethods(): SyncMethods<T> {
    if (!this.methods) throw new Error('Engine sync feed is not connected');
    return this.methods;
  }
}

const membershipKey = (scopeKey: string, entityId: string): string => `${scopeKey}:${entityId}`;
const rankAlphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const fractionalOrderKey = (lower: string | undefined, upper: string | undefined): string => {
  let prefix = '';
  for (let index = 0; ; index += 1) {
    const lowerCharacter = lower?.[index] ?? rankAlphabet[0]!;
    const upperCharacter = upper?.[index] ?? rankAlphabet.at(-1)!;
    if (lowerCharacter === upperCharacter) {
      prefix += lowerCharacter;
      continue;
    }
    const lowerIndex = rankAlphabet.indexOf(lowerCharacter);
    const upperIndex = rankAlphabet.indexOf(upperCharacter);
    if (lowerIndex < 0 || upperIndex < 0 || lowerIndex > upperIndex) throw new Error('Invalid fractional order bounds');
    if (upperIndex - lowerIndex > 1) return `${prefix}${rankAlphabet[Math.floor((lowerIndex + upperIndex) / 2)]!}`;
    return `${prefix}${lowerCharacter}${lower?.slice(index + 1) ?? ''}${rankAlphabet[Math.floor(rankAlphabet.length / 2)]!}`;
  }
};
const engineAdapters = new Map<string, EngineAdapter>();
let engineAdapterSequence = 0;
let engineScopeCollectionCount = 0;

(globalThis as Record<string, unknown>).__DBLAYER_ENGINE_SCOPE_COLLECTIONS__ = {
  count: (): number => engineScopeCollectionCount
};

export const createEngineAdapter = (options: EngineAdapterOptions = {}): EngineAdapter => {
  const adapterId = engineAdapterSequence += 1;
  const entityFeed = new SyncFeed<EngineEntityRow>();
  const membershipFeed = new SyncFeed<EngineMembershipRow>();
  const entities = createCollection<EngineEntityRow>({
    id: 'dblayer-engine-entities',
    getKey: row => row.id,
    startSync: true,
    sync: { sync: entityFeed.sync }
  });
  const memberships = createCollection<EngineMembershipRow>({
    id: 'dblayer-engine-memberships',
    getKey: row => membershipKey(row.scopeKey, row.entityId),
    startSync: true,
    sync: { sync: membershipFeed.sync }
  });
  entities.createIndex(row => row.id, { indexType: BasicIndex });
  const membershipsByScope = memberships.createIndex(row => row.scopeKey, { indexType: BasicIndex });

  const entityRows = new Map<string, EngineEntityRow>();
  const membershipRows = new Map<string, EngineMembershipRow>();
  const scopeCollections = new Map<string, { collection: LiveScopeCollection; consumers: number }>();
  let ready = false;
  const getScopeCollection = (scopeKey: string) => {
    const existing = scopeCollections.get(scopeKey);
    if (existing) return existing;
    const entry = {
      collection: createLiveQueryCollection({
        id: `dblayer-engine-scope-${adapterId}-${scopeKey}`,
        startSync: true,
        query: q => q
          .from({ membership: memberships })
          .where(({ membership }) => eq(membership.scopeKey, scopeKey))
          .join({ entity: entities }, ({ membership, entity }) => eq(membership.entityId, entity.id))
          .orderBy(({ membership }) => membership.orderKey, { direction: 'asc', stringSort: 'lexical' })
          .select(({ membership, entity }) => ({ ...entity, orderKey: membership.orderKey })),
        getKey: row => row.$key
      }),
      consumers: 0
    };
    scopeCollections.set(scopeKey, entry);
    engineScopeCollectionCount += 1;
    return entry;
  };
  const releaseScopeCollection = (scopeKey: string, entry: { collection: LiveScopeCollection; consumers: number }): void => {
    entry.consumers -= 1;
    if (entry.consumers !== 0 || scopeCollections.get(scopeKey) !== entry) return;
    scopeCollections.delete(scopeKey);
    engineScopeCollectionCount -= 1;
    void entry.collection.cleanup();
  };
  const dispose = (): void => {
    for (const entry of scopeCollections.values()) void entry.collection.cleanup();
    engineScopeCollectionCount -= scopeCollections.size;
    scopeCollections.clear();
  };
  const membershipsForScopeOrder = (changes: readonly EngineMembershipChange[], scopeOrder: readonly string[]): EngineMembershipChange[] => {
    const scopeKey = changes.find(change => change.type === 'upsert')?.value.scopeKey ?? changes.find(change => change.type === 'delete')?.scopeKey;
    if (!scopeKey) return [...changes];
    const upserts = new Map(changes.flatMap(change => change.type === 'upsert' ? [[change.value.entityId, change] as const] : []));
    const deletedIds = new Set(changes.flatMap(change => change.type === 'delete' && !upserts.has(change.entityId) ? [change.entityId] : []));
    const ranks = new Map(
      [...membershipRows.values()]
        .filter(row => row.scopeKey === scopeKey && !deletedIds.has(row.entityId) && !upserts.has(row.entityId))
        .map(row => [row.entityId, row.orderKey] as const)
    );
    for (let index = 0; index < scopeOrder.length; index += 1) {
      const entityId = scopeOrder[index]!;
      if (!upserts.has(entityId)) continue;
      const lower = scopeOrder.slice(0, index).reverse().map(id => ranks.get(id)).find(Boolean);
      const upper = scopeOrder.slice(index + 1).map(id => ranks.get(id)).find(Boolean);
      ranks.set(entityId, fractionalOrderKey(lower, upper));
    }
    return changes.map(change => change.type === 'upsert'
      ? { type: 'upsert' as const, value: { ...change.value, orderKey: ranks.get(change.value.entityId) ?? change.value.orderKey } }
      : change);
  };
  const adapter: EngineAdapter = {
    apply: plan => {
      const entityMessages = plan.entities.map(change => change.type === 'upsert' ? { type: entityRows.has(change.value.id) ? 'update' as const : 'insert' as const, value: change.value } : { type: 'delete' as const, key: change.id });
      const membershipChanges = plan.scopeOrder ? membershipsForScopeOrder(plan.memberships, plan.scopeOrder) : plan.memberships;
      const membershipMessages = membershipChanges.map(change => change.type === 'upsert'
        ? { type: membershipRows.has(membershipKey(change.value.scopeKey, change.value.entityId)) ? 'update' as const : 'insert' as const, value: change.value }
        : { type: 'delete' as const, key: membershipKey(change.scopeKey, change.entityId) });
      for (const change of plan.entities) {
        if (change.type === 'upsert') entityRows.set(change.value.id, change.value);
        else entityRows.delete(change.id);
      }
      if (entityMessages.length > 0 && membershipMessages.length > 0) {
        entityFeed.start();
        membershipFeed.start();
        for (const message of entityMessages) entityFeed.pushMessage(message);
        for (const message of membershipMessages) membershipFeed.pushMessage(message);
        entityFeed.finish();
        membershipFeed.finish();
      } else {
        if (entityMessages.length > 0) entityFeed.push(entityMessages);
        if (membershipMessages.length > 0) membershipFeed.push(membershipMessages);
      }
      if (plan.entities.length > 0) options.onPhase?.('entities', adapter);

      for (const change of membershipChanges) {
        const key = change.type === 'upsert' ? membershipKey(change.value.scopeKey, change.value.entityId) : membershipKey(change.scopeKey, change.entityId);
        if (change.type === 'upsert') membershipRows.set(key, change.value);
        else membershipRows.delete(key);
      }
      if (membershipChanges.length > 0) options.onMembershipWrite?.(plan.membershipWriteKind ?? 'delta', membershipChanges);
      if (membershipChanges.length > 0) options.onPhase?.('memberships', adapter);
    },
    markReady: () => {
      entityFeed.markReady();
      membershipFeed.markReady();
      ready = true;
    },
    readEntity: id => ready ? entityRows.get(id) : undefined,
    readScope: scopeKey => ready
      ? [...membershipsByScope.equalityLookup(scopeKey)]
        .flatMap(key => {
          if (typeof key !== 'string') return [];
          const row = membershipRows.get(key);
          return row && entityRows.has(row.entityId) ? [row] : [];
        })
        .sort((left, right) => left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : 0)
        .map(row => row.entityId)
      : [],
    scopeCollection: scopeKey => ({
      toArray: () => ready ? [...getScopeCollection(scopeKey).collection.toArray] : [],
      subscribe: listener => {
        const entry = getScopeCollection(scopeKey);
        entry.consumers += 1;
        const subscription = entry.collection.subscribeChanges(changes => listener(changes as EngineScopeChange[]), { includeInitialState: false });
        return () => {
          subscription.unsubscribe();
          releaseScopeCollection(scopeKey, entry);
        };
      }
    }),
    replaceScope: (scopeKey, entityIds) => {
      const nextIds = new Set(entityIds);
      const memberships: EngineMembershipChange[] = [
        ...[...membershipRows.values()]
          .filter(row => row.scopeKey === scopeKey && !nextIds.has(row.entityId))
          .map(row => ({ type: 'delete' as const, scopeKey, entityId: row.entityId })),
        ...entityIds.reduce<Array<Extract<EngineMembershipChange, { type: 'upsert' }>>>((changes, entityId) => {
          const previous = changes.at(-1)?.value.orderKey;
          changes.push({ type: 'upsert', value: { scopeKey, entityId, orderKey: fractionalOrderKey(previous, undefined) } });
          return changes;
        }, [])
      ];
      adapter.apply({ entities: [], memberships, membershipWriteKind: 'rebuild' });
    },
    dispose
  };

  return adapter;
};

const adapterFor = (model: string): EngineAdapter => {
  const existing = engineAdapters.get(model);
  if (existing) return existing;
  const next = createEngineAdapter();
  engineAdapters.set(model, next);
  return next;
};

const upsertRows = (model: string, batch: EngineBatch, target: EngineApplyTarget): EngineEntityChange[] =>
  batch.rows
    .filter(change => change.model === model)
    .map(change => {
      const row = target.readRow(change.id);
      return row ? { type: 'upsert' as const, value: row as EngineEntityRow } : { type: 'delete' as const, id: change.id };
    });

export const syncEngineBatch = (batch: EngineBatch, getTarget: (model: string) => EngineApplyTarget, readyAfterApply = false, resolveAdapter: (model: string) => EngineAdapter = adapterFor): void => {
  const models = new Set([...batch.rows.map(change => change.model), ...batch.scopes.map(change => change.model), ...(batch.scopeChanges ?? []).map(change => change.model)]);
  for (const model of models) {
    const target = getTarget(model);
    const adapter = resolveAdapter(model);
    const detailedScopes = batch.scopeChanges ?? [];
    const scopeByKey = new Map<string, EngineScopeDelta>();
    for (const scope of batch.scopes.filter(change => change.model === model)) {
      scopeByKey.set(scope.scopeKey, detailedScopes.find(detail => detail.model === model && detail.scopeKey === scope.scopeKey) ?? scope);
    }
    for (const scope of detailedScopes.filter(change => change.model === model)) scopeByKey.set(scope.scopeKey, scope);
    const scopeChanges = [...scopeByKey.values()];
    adapter.apply({ entities: upsertRows(model, batch, target), memberships: [] });
    for (const change of scopeChanges) {
      const orderChanged = batch.rows.some(row => row.model === model && target.scopeOrderAffected(change.scopeKey, row.id, row.fields));
      if (change.rebuild === true || orderChanged) {
        adapter.replaceScope(change.scopeKey, target.readScopeOrder(change.scopeKey));
        continue;
      }
      const appendIds = [...new Set([...(change.appendIds ?? []), ...(change.appendEntries ?? []).map(entry => entry.id)])];
      const memberships: EngineMembershipChange[] = [
        ...(change.detachIds ?? []).map(entityId => ({ type: 'delete' as const, scopeKey: change.scopeKey, entityId })),
        ...appendIds.map(entityId => ({ type: 'upsert' as const, value: { scopeKey: change.scopeKey, entityId, orderKey: '' } }))
      ];
      if (memberships.length > 0) adapter.apply({ entities: [], memberships, scopeOrder: target.readScopeOrder(change.scopeKey) });
    }
    if (readyAfterApply) adapter.markReady();
  }
};

export const hydrateEngines = (targets: ReadonlyArray<readonly [string, EngineApplyTarget]>): void => {
  for (const [model, target] of targets) {
    const adapter = adapterFor(model);
    adapter.apply({ entities: target.readAllRows().map(value => ({ type: 'upsert', value: value as EngineEntityRow })), memberships: [] });
    for (const scopeKey of target.readAllScopeKeys()) adapter.replaceScope(scopeKey, target.readScopeOrder(scopeKey));
  }
};

export const markEnginesReady = (): void => {
  for (const adapter of engineAdapters.values()) adapter.markReady();
};

export const resetEngines = (): void => {
  for (const adapter of engineAdapters.values()) adapter.dispose();
  engineAdapters.clear();
};

export const engineScopeCollection = (model: string, scopeKey: string): EngineScopeCollection => adapterFor(model).scopeCollection(scopeKey);
