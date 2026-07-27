import { BasicIndex, createCollection, eq, type ChangeMessageOrDeleteKeyMessage } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';

type EntityRow = { id: string } & Record<string, unknown>;
type MembershipRow = { scopeKey: string; entityId: string; orderKey: string };
type SyncMethods<T extends object> = {
  begin: () => void;
  write: (message: ChangeMessageOrDeleteKeyMessage<T, string>) => void;
  commit: () => void;
  markReady: () => void;
};
type EntityChange = { type: 'upsert'; value: EntityRow } | { type: 'delete'; id: string };
type MembershipChange = { type: 'upsert'; value: MembershipRow } | { type: 'delete'; scopeKey: string; entityId: string };
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
type EngineScopeChange = NonNullable<EngineBatch['scopeChanges']>[number];

export type EnginePlan = {
  entities: readonly EntityChange[];
  memberships: readonly MembershipChange[];
  membershipWriteKind?: 'delta' | 'rebuild';
  scopeOrder?: readonly string[];
};
export type EngineAdapter = {
  apply(plan: EnginePlan): void;
  markReady(): void;
  readEntity(id: string): EntityRow | undefined;
  readScope(scopeKey: string): string[];
  readScopeRows(scopeKey: string): EntityRow[];
  readScopeRevision(scopeKey: string): number;
  useScopeRows(scopeKey: string | null): EntityRow[];
  replaceScope(scopeKey: string, entityIds: readonly string[]): void;
};

type EngineAdapterOptions = {
  onPhase?: (name: 'entities' | 'memberships', current: EngineAdapter) => void;
  onMembershipWrite?: (kind: 'delta' | 'rebuild', changes: readonly MembershipChange[]) => void;
};

class SyncFeed<T extends object> {
  private methods: SyncMethods<T> | null = null;

  sync = (methods: SyncMethods<T>): (() => void) => {
    this.methods = methods;
    return () => {
      if (this.methods === methods) this.methods = null;
    };
  };

  apply(messages: readonly ChangeMessageOrDeleteKeyMessage<T, string>[]): void {
    const methods = this.requireMethods();
    methods.begin();
    for (const message of messages) methods.write(message);
    methods.commit();
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
const selectEntityRows = (rows: readonly object[] | undefined): EntityRow[] => (rows ?? []).flatMap(row => {
  const value = Object.fromEntries(Object.entries(row));
  return typeof value.id === 'string' ? [{ ...value, id: value.id }] : [];
});

export const createEngineAdapter = (options: EngineAdapterOptions = {}): EngineAdapter => {
  const entityFeed = new SyncFeed<EntityRow>();
  const membershipFeed = new SyncFeed<MembershipRow>();
  const entities = createCollection<EntityRow>({
    id: 'dblayer-engine-entities',
    getKey: row => row.id,
    startSync: true,
    sync: { sync: entityFeed.sync }
  });
  const memberships = createCollection<MembershipRow>({
    id: 'dblayer-engine-memberships',
    getKey: row => membershipKey(row.scopeKey, row.entityId),
    startSync: true,
    sync: { sync: membershipFeed.sync }
  });
  entities.createIndex(row => row.id, { indexType: BasicIndex });
  const membershipsByScope = memberships.createIndex(row => row.scopeKey, { indexType: BasicIndex });

  const entityRows = new Map<string, EntityRow>();
  const membershipRows = new Map<string, MembershipRow>();
  const scopeRevisions = new Map<string, number>();
  let ready = false;
  const membershipsForScopeOrder = (changes: readonly MembershipChange[], scopeOrder: readonly string[]): MembershipChange[] => {
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
      entityFeed.apply(entityMessages);
      for (const change of plan.entities) {
        if (change.type === 'upsert') entityRows.set(change.value.id, change.value);
        else entityRows.delete(change.id);
      }
      if (plan.entities.length > 0) options.onPhase?.('entities', adapter);

      const membershipChanges = plan.scopeOrder ? membershipsForScopeOrder(plan.memberships, plan.scopeOrder) : plan.memberships;
      const membershipMessages = membershipChanges.map(change => change.type === 'upsert'
        ? { type: membershipRows.has(membershipKey(change.value.scopeKey, change.value.entityId)) ? 'update' as const : 'insert' as const, value: change.value }
        : { type: 'delete' as const, key: membershipKey(change.scopeKey, change.entityId) });
      membershipFeed.apply(membershipMessages);
      for (const change of membershipChanges) {
        const key = change.type === 'upsert' ? membershipKey(change.value.scopeKey, change.value.entityId) : membershipKey(change.scopeKey, change.entityId);
        const previous = membershipRows.get(key);
        if (change.type === 'upsert') membershipRows.set(key, change.value);
        else membershipRows.delete(key);
        const scopeKey = change.type === 'upsert' ? change.value.scopeKey : change.scopeKey;
        const changed = change.type === 'upsert'
          ? previous?.orderKey !== change.value.orderKey
          : previous !== undefined;
        if (changed) scopeRevisions.set(scopeKey, (scopeRevisions.get(scopeKey) ?? 0) + 1);
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
    readScopeRows: scopeKey => ready ? adapter.readScope(scopeKey).flatMap(id => {
      const row = entityRows.get(id);
      return row ? [row] : [];
    }) : [],
    readScopeRevision: scopeKey => scopeRevisions.get(scopeKey) ?? 0,
    useScopeRows: scopeKey => {
      const { data } = useLiveQuery(q => scopeKey == null ? undefined : q
        .from({ membership: memberships })
        .where(({ membership }) => eq(membership.scopeKey, scopeKey))
        .join({ entity: entities }, ({ membership, entity }) => eq(membership.entityId, entity.id))
        .orderBy(({ membership }) => membership.orderKey, { direction: 'asc', stringSort: 'lexical' })
        .select(({ entity }) => entity), [scopeKey]);
      return ready ? selectEntityRows(data) : [];
    },
    replaceScope: (scopeKey, entityIds) => {
      const nextIds = new Set(entityIds);
      const memberships: MembershipChange[] = [
        ...[...membershipRows.values()]
          .filter(row => row.scopeKey === scopeKey && !nextIds.has(row.entityId))
          .map(row => ({ type: 'delete' as const, scopeKey, entityId: row.entityId })),
        ...entityIds.reduce<Array<Extract<MembershipChange, { type: 'upsert' }>>>((changes, entityId) => {
          const previous = changes.at(-1)?.value.orderKey;
          changes.push({ type: 'upsert', value: { scopeKey, entityId, orderKey: fractionalOrderKey(previous, undefined) } });
          return changes;
        }, [])
      ];
      adapter.apply({ entities: [], memberships, membershipWriteKind: 'rebuild' });
    }
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

const upsertRows = (model: string, batch: EngineBatch, target: EngineApplyTarget): EntityChange[] =>
  batch.rows
    .filter(change => change.model === model)
    .map(change => {
      const row = target.readRow(change.id);
      return row ? { type: 'upsert' as const, value: row as EntityRow } : { type: 'delete' as const, id: change.id };
    });

export const syncEngineBatch = (batch: EngineBatch, getTarget: (model: string) => EngineApplyTarget, readyAfterApply = false, resolveAdapter: (model: string) => EngineAdapter = adapterFor): void => {
  const models = new Set([...batch.rows.map(change => change.model), ...batch.scopes.map(change => change.model), ...(batch.scopeChanges ?? []).map(change => change.model)]);
  for (const model of models) {
    const target = getTarget(model);
    const adapter = resolveAdapter(model);
    const detailedScopes = batch.scopeChanges ?? [];
    const scopeByKey = new Map<string, EngineScopeChange>();
    for (const scope of batch.scopes.filter(change => change.model === model)) {
      scopeByKey.set(scope.scopeKey, detailedScopes.find(detail => detail.model === model && detail.scopeKey === scope.scopeKey) ?? scope);
    }
    for (const scope of detailedScopes.filter(change => change.model === model)) scopeByKey.set(scope.scopeKey, scope);
    const scopeChanges = [...scopeByKey.values()];
    adapter.apply({ entities: upsertRows(model, batch, target), memberships: [] });
    for (const change of scopeChanges) {
      if (change.rebuild === true) {
        adapter.replaceScope(change.scopeKey, target.readScopeOrder(change.scopeKey));
        continue;
      }
      const appendIds = [...new Set([...(change.appendIds ?? []), ...(change.appendEntries ?? []).map(entry => entry.id)])];
      const memberships: MembershipChange[] = [
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
    adapter.apply({ entities: target.readAllRows().map(value => ({ type: 'upsert', value: value as EntityRow })), memberships: [] });
    for (const scopeKey of target.readAllScopeKeys()) adapter.replaceScope(scopeKey, target.readScopeOrder(scopeKey));
  }
};

export const markEnginesReady = (): void => {
  for (const adapter of engineAdapters.values()) adapter.markReady();
};

export const resetEngines = (): void => {
  engineAdapters.clear();
};

export const useEngineScopeRows = (model: string, scopeKey: string | null): EntityRow[] => adapterFor(model).useScopeRows(scopeKey);

export const readEngineScopeRows = (model: string, scopeKey: string): EntityRow[] => adapterFor(model).readScopeRows(scopeKey);

export const readEngineScopeRevision = (model: string, scopeKey: string): number => adapterFor(model).readScopeRevision(scopeKey);
