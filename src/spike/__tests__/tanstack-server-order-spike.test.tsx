import { BasicIndex, createCollection, createLiveQueryCollection, eq } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { act } from 'react-test-renderer';
import { defineModel, f, resetRuntime, scope } from '../../index';
import { diagnostics, renderCounted, settle, setupSpecRuntime } from '../../__tests__/spec/helpers/harness';

type MessageRow = { id: string; threadId: string; body: string };
type MembershipRow = { scopeKey: string; entityKey: string; order: number };
type AliasedMessageRow = { entityKey: string; clientId: string; serverId?: string; threadId: string; body: string };
type AliasedMembershipRow = { scopeKey: string; entityKey: string; order: number };
type ScopeValue = { threadId: string };
type SyncMessage<T extends object> =
  | { type: 'insert' | 'update'; value: T }
  | { type: 'delete'; key: string };
type SyncMethods<T extends object> = {
  begin: () => void;
  write: (message: SyncMessage<T>) => void;
  commit: () => void;
  markReady: () => void;
};

type BaselineMeasurement = {
  size: number;
  commitBatches: number;
  readerNotifications: number;
  selectCalls: number;
  orderKeyCalls: null;
  comparatorCalls: null;
  identityChanges: number;
  scopeReadPasses: number;
  scopeReadResorts: number;
};

type TanStackMeasurement = {
  size: number;
  logicalSyncCommits: number;
  entitySyncWrites: number;
  membershipSyncWrites: number;
  resultChangedKeys: number;
  intermediateResultHasAppendedRow: boolean;
  readerNotifications: number;
  selectCalls: number;
  orderKeyCalls: number;
  comparatorCalls: null;
  identityChanges: number;
  liveQueryRuns: number;
};

type Measurement = { baseline: BaselineMeasurement; tanstack: TanStackMeasurement };

type ServerBindingMeasurement = {
  size: number;
  optimisticVisible: boolean;
  resultChangedKeys: number;
  targetPositionPreserved: boolean;
  resultKeysPreserved: boolean;
  neighborIdentityChanges: number;
  duplicateServerIdChangedKeys: number;
  duplicateServerIdKeepsKey: boolean;
  deletedServerResurrectsEntity: boolean;
  deletedServerVisibleInScope: boolean;
};

type SparseOrderMeasurement = {
  size: number;
  resultChangedKeys: number;
  changedMembershipKeys: number;
  orderPreserved: boolean;
  sameGapInsertLimit: number;
};

class SyncFeed<T extends object> {
  private methods: SyncMethods<T> | null = null;
  writes = 0;

  constructor(private readonly initialRows: readonly T[]) {}

  sync = (methods: SyncMethods<T>): (() => void) => {
    this.methods = methods;
    methods.begin();
    for (const value of this.initialRows) methods.write({ type: 'insert', value });
    methods.commit();
    methods.markReady();
    return () => {
      if (this.methods === methods) this.methods = null;
    };
  };

  begin(): void {
    const methods = this.methods;
    if (!methods) throw new Error('Sync feed is not connected');
    methods.begin();
  }

  insert(value: T): void {
    const methods = this.methods;
    if (!methods) throw new Error('Sync feed is not connected');
    methods.write({ type: 'insert', value });
  }

  update(value: T): void {
    const methods = this.methods;
    if (!methods) throw new Error('Sync feed is not connected');
    methods.write({ type: 'update', value });
  }

  delete(key: string): void {
    const methods = this.methods;
    if (!methods) throw new Error('Sync feed is not connected');
    methods.write({ type: 'delete', key });
  }

  commit(): void {
    const methods = this.methods;
    if (!methods) throw new Error('Sync feed is not connected');
    methods.commit();
    this.writes += 1;
  }
}

class SyncAppendTransaction {
  commits = 0;

  constructor(private readonly entityFeed: SyncFeed<MessageRow>, private readonly membershipFeed: SyncFeed<MembershipRow>) {}

  append(entity: MessageRow, membership: MembershipRow, afterMembershipCommit: () => void): void {
    this.entityFeed.begin();
    this.membershipFeed.begin();
    this.entityFeed.insert(entity);
    this.membershipFeed.insert(membership);
    this.membershipFeed.commit();
    afterMembershipCommit();
    this.entityFeed.commit();
    this.commits += 1;
  }
}

const createMessages = (size: number): MessageRow[] =>
  Array.from({ length: size }, (_, index) => ({ id: `message-${index}`, threadId: 'thread-1', body: `body-${index}` }));

const createMembership = (messages: readonly MessageRow[]): MembershipRow[] =>
  messages.map((message, order) => ({ scopeKey: message.threadId, entityKey: message.id, order }));

const measureBaseline = async (size: number): Promise<BaselineMeasurement> => {
  setupSpecRuntime();
  const messages = defineModel({
    id: `SpikeBaselineMessage${size}`,
    name: `SpikeBaselineMessage${size}`,
    fields: { threadId: f.str(), body: f.str() },
    scopes: { thread: scope<ScopeValue>({ by: { threadId: 'threadId' }, sort: 'server-order' }) }
  });
  messages.insertMany(createMessages(size));

  let selectCalls = 0;
  const reader = renderCounted(() => {
    return messages.scopes.thread.use({ threadId: 'thread-1' }, {
      select: row => {
        selectCalls += 1;
        return { id: row.id, body: row.body };
      }
    });
  });
  await settle();
  const previousRows = reader.result();
  const rendersBeforeAppend = reader.renders();
  selectCalls = 0;
  diagnostics().reset();

  act(() => {
    messages.insert({ id: `message-${size}`, threadId: 'thread-1', body: `body-${size}` });
  });
  await settle();

  const nextRows = reader.result();
  expect(nextRows.map(row => row.id)).toEqual(Array.from({ length: size + 1 }, (_, index) => `message-${index}`));
  const snapshot = diagnostics().snapshot();
  const measurement = {
    size,
    commitBatches: snapshot.commits,
    readerNotifications: reader.renders() - rendersBeforeAppend,
    selectCalls,
    orderKeyCalls: null,
    comparatorCalls: null,
    identityChanges: nextRows.reduce((count, row, index) => count + Number(row !== previousRows[index]), 0),
    scopeReadPasses: snapshot.scopeReadPasses,
    scopeReadResorts: snapshot.scopeReadResorts
  };
  reader.unmount();
  return measurement;
};

const measureTanStack = async (size: number): Promise<TanStackMeasurement> => {
  const initialMessages = createMessages(size);
  const entityFeed = new SyncFeed<MessageRow>(initialMessages);
  const membershipFeed = new SyncFeed<MembershipRow>(createMembership(initialMessages));
  const entities = createCollection<MessageRow>({
    id: `spike-entities-${size}`,
    getKey: row => row.id,
    startSync: true,
    sync: { sync: entityFeed.sync }
  });
  const membership = createCollection<MembershipRow>({
    id: `spike-membership-${size}`,
    getKey: row => `${row.scopeKey}:${row.entityKey}`,
    startSync: true,
    sync: { sync: membershipFeed.sync }
  });
  entities.createIndex(row => row.id, { indexType: BasicIndex });
  membership.createIndex(row => row.scopeKey, { indexType: BasicIndex });
  let selectCalls = 0;
  let orderKeyCalls = 0;
  const scopedMessages = createLiveQueryCollection({
    id: `spike-thread-${size}`,
    query: q =>
      q
        .from({ membership })
        .where(({ membership }) => eq(membership.scopeKey, 'thread-1'))
        .join({ entity: entities }, ({ membership, entity }) => eq(membership.entityKey, entity.id))
        .orderBy(({ membership }) => {
          orderKeyCalls += 1;
          return membership.order;
        }, 'asc')
        .select(({ membership, entity }) => {
          selectCalls += 1;
          return { id: entity.id, order: membership.order };
        })
  });

  const reader = renderCounted(() => {
    const { data } = useLiveQuery(scopedMessages);
    return data;
  });
  await settle();
  expect(reader.result().map(row => row.id)).toEqual(Array.from({ length: size }, (_, index) => `message-${index}`));

  const runsBeforeAppend = scopedMessages.utils.getRunCount();
  const rendersBeforeAppend = reader.renders();
  const previousRows = reader.result();
  selectCalls = 0;
  orderKeyCalls = 0;
  const resultChangedKeys = new Set<string | number>();
  let intermediateResultHasAppendedRow = true;
  const resultSubscription = scopedMessages.subscribeChanges(changes => {
    for (const change of changes) resultChangedKeys.add(change.key);
  }, { includeInitialState: false });
  const append = new SyncAppendTransaction(entityFeed, membershipFeed);
  append.append(
    { id: `message-${size}`, threadId: 'thread-1', body: `body-${size}` },
    { scopeKey: 'thread-1', entityKey: `message-${size}`, order: size },
    () => {
      intermediateResultHasAppendedRow = Array.from(scopedMessages.values()).some(row => row.id === `message-${size}`);
    }
  );
  await settle();
  resultSubscription.unsubscribe();

  const nextRows = reader.result();
  expect(nextRows.map(row => row.id)).toEqual(Array.from({ length: size + 1 }, (_, index) => `message-${index}`));
  const measurement = {
    size,
    logicalSyncCommits: append.commits,
    entitySyncWrites: entityFeed.writes,
    membershipSyncWrites: membershipFeed.writes,
    resultChangedKeys: resultChangedKeys.size,
    intermediateResultHasAppendedRow,
    readerNotifications: reader.renders() - rendersBeforeAppend,
    selectCalls,
    orderKeyCalls,
    comparatorCalls: null,
    identityChanges: nextRows.reduce((count, row, index) => count + Number(row !== previousRows[index]), 0),
    liveQueryRuns: scopedMessages.utils.getRunCount() - runsBeforeAppend
  };
  reader.unmount();
  return measurement;
};

const measureServerBinding = async (size: number): Promise<ServerBindingMeasurement> => {
  const initialEntities = Array.from({ length: size }, (_, index) => ({
    entityKey: `entity-${index}`,
    clientId: `client-${index}`,
    threadId: 'thread-1',
    body: `body-${index}`
  }));
  const initialMembership = initialEntities.map((entity, order) => ({
    scopeKey: entity.threadId,
    entityKey: entity.entityKey,
    order
  }));
  const entityFeed = new SyncFeed<AliasedMessageRow>(initialEntities);
  const membershipFeed = new SyncFeed<AliasedMembershipRow>(initialMembership);
  const entities = createCollection<AliasedMessageRow>({
    id: `alias-entities-${size}`,
    getKey: row => row.entityKey,
    startSync: true,
    sync: { sync: entityFeed.sync }
  });
  const membership = createCollection<AliasedMembershipRow>({
    id: `alias-membership-${size}`,
    getKey: row => `${row.scopeKey}:${row.entityKey}`,
    startSync: true,
    sync: { sync: membershipFeed.sync }
  });
  entities.createIndex(row => row.entityKey, { indexType: BasicIndex });
  membership.createIndex(row => row.scopeKey, { indexType: BasicIndex });
  const scopedMessages = createLiveQueryCollection({
    id: `alias-thread-${size}`,
    query: q =>
      q
        .from({ membership })
        .where(({ membership }) => eq(membership.scopeKey, 'thread-1'))
        .join({ entity: entities }, ({ membership, entity }) => eq(membership.entityKey, entity.entityKey))
        .orderBy(({ membership }) => membership.order, 'asc')
        .select(({ membership, entity }) => ({
          entityKey: entity.entityKey,
          clientId: entity.clientId,
          serverId: entity.serverId,
          body: entity.body,
          order: membership.order
        }))
  });
  const reader = renderCounted(() => useLiveQuery(scopedMessages).data);
  await settle();

  const entityKey = `entity-client-${size}`;
  const clientId = `temporary-${size}`;
  const aliases = new Map<string, string>([[clientId, entityKey]]);
  const optimisticEntity = { entityKey, clientId, threadId: 'thread-1', body: 'optimistic' };
  const optimisticMembership = { scopeKey: 'thread-1', entityKey, order: size };
  entityFeed.begin();
  membershipFeed.begin();
  entityFeed.insert(optimisticEntity);
  membershipFeed.insert(optimisticMembership);
  membershipFeed.commit();
  entityFeed.commit();
  await settle();

  const optimisticRows = reader.result();
  const optimisticTargetPosition = optimisticRows.findIndex(row => row.entityKey === entityKey);
  expect(optimisticTargetPosition).toBe(size);
  expect(entities.has(entityKey)).toBe(true);
  const optimisticResultKeys = Array.from(scopedMessages.keys());
  const changedResultKeys = new Set<string | number>();
  const resultSubscription = scopedMessages.subscribeChanges(changes => {
    for (const change of changes) changedResultKeys.add(change.key);
  }, { includeInitialState: false });
  const serverId = `server-${size}`;
  const resolvedEntityKey = aliases.get(clientId);
  expect(resolvedEntityKey).toBe(entityKey);
  aliases.set(serverId, resolvedEntityKey!);
  entityFeed.begin();
  entityFeed.update({ entityKey, clientId, serverId, threadId: 'thread-1', body: 'confirmed' });
  entityFeed.commit();
  await settle();
  resultSubscription.unsubscribe();

  const boundRows = reader.result();
  const boundResultKeys = Array.from(scopedMessages.keys());
  const boundTargetPosition = boundRows.findIndex(row => row.entityKey === entityKey);
  expect(boundRows[boundTargetPosition]?.serverId).toBe(serverId);
  expect(boundRows[boundTargetPosition]?.body).toBe('confirmed');
  expect(boundTargetPosition).toBe(optimisticTargetPosition);
  expect(boundResultKeys).toEqual(optimisticResultKeys);
  const neighborIdentityChanges = boundRows.reduce((count, row, index) => {
    if (index === optimisticTargetPosition) return count;
    return count + Number(row !== optimisticRows[index]);
  }, 0);

  const duplicateChangedResultKeys = new Set<string | number>();
  const duplicateSubscription = scopedMessages.subscribeChanges(changes => {
    for (const change of changes) duplicateChangedResultKeys.add(change.key);
  }, { includeInitialState: false });
  const duplicateEntityKey = aliases.get(serverId);
  expect(duplicateEntityKey).toBe(entityKey);
  entityFeed.begin();
  entityFeed.update({ entityKey: duplicateEntityKey!, clientId, serverId, threadId: 'thread-1', body: 'confirmed' });
  entityFeed.commit();
  await settle();
  duplicateSubscription.unsubscribe();

  membershipFeed.begin();
  membershipFeed.delete(`${optimisticMembership.scopeKey}:${entityKey}`);
  membershipFeed.commit();
  entityFeed.begin();
  entityFeed.delete(entityKey);
  entityFeed.commit();
  await settle();
  expect(reader.result().some(row => row.entityKey === entityKey)).toBe(false);
  entityFeed.begin();
  entityFeed.update({ entityKey, clientId, serverId, threadId: 'thread-1', body: 'late-server-node' });
  entityFeed.commit();
  await settle();

  const measurement = {
    size,
    optimisticVisible: optimisticTargetPosition !== -1,
    resultChangedKeys: changedResultKeys.size,
    targetPositionPreserved: boundTargetPosition === optimisticTargetPosition,
    resultKeysPreserved: JSON.stringify(boundResultKeys) === JSON.stringify(optimisticResultKeys),
    neighborIdentityChanges,
    duplicateServerIdChangedKeys: duplicateChangedResultKeys.size,
    duplicateServerIdKeepsKey: aliases.get(serverId) === entityKey && entities.has(entityKey),
    deletedServerResurrectsEntity: entities.has(entityKey),
    deletedServerVisibleInScope: reader.result().some(row => row.entityKey === entityKey)
  };
  reader.unmount();
  return measurement;
};

const measureSparseOrder = async (size: number): Promise<SparseOrderMeasurement> => {
  const orderStep = 1024;
  const initialMessages = createMessages(size);
  const entityFeed = new SyncFeed<MessageRow>(initialMessages);
  const membershipFeed = new SyncFeed<MembershipRow>(initialMessages.map((message, index) => ({
    scopeKey: message.threadId,
    entityKey: message.id,
    order: index * orderStep
  })));
  const entities = createCollection<MessageRow>({
    id: `sparse-entities-${size}`,
    getKey: row => row.id,
    startSync: true,
    sync: { sync: entityFeed.sync }
  });
  const membership = createCollection<MembershipRow>({
    id: `sparse-membership-${size}`,
    getKey: row => `${row.scopeKey}:${row.entityKey}`,
    startSync: true,
    sync: { sync: membershipFeed.sync }
  });
  entities.createIndex(row => row.id, { indexType: BasicIndex });
  membership.createIndex(row => row.scopeKey, { indexType: BasicIndex });
  const scopedMessages = createLiveQueryCollection({
    id: `sparse-thread-${size}`,
    query: q =>
      q
        .from({ membership })
        .where(({ membership }) => eq(membership.scopeKey, 'thread-1'))
        .join({ entity: entities }, ({ membership, entity }) => eq(membership.entityKey, entity.id))
        .orderBy(({ membership }) => membership.order, 'asc')
        .select(({ membership, entity }) => ({ id: entity.id, order: membership.order }))
  });
  const reader = renderCounted(() => useLiveQuery(scopedMessages).data);
  await settle();

  const insertAfter = Math.floor(size / 2) - 1;
  const insertedId = `message-middle-${size}`;
  const insertedOrder = (insertAfter * orderStep + (insertAfter + 1) * orderStep) / 2;
  const changedResultKeys = new Set<string | number>();
  const changedMembershipKeys = new Set<string | number>();
  const resultSubscription = scopedMessages.subscribeChanges(changes => {
    for (const change of changes) changedResultKeys.add(change.key);
  }, { includeInitialState: false });
  const membershipSubscription = membership.subscribeChanges(changes => {
    for (const change of changes) changedMembershipKeys.add(change.key);
  }, { includeInitialState: false });
  entityFeed.begin();
  membershipFeed.begin();
  entityFeed.insert({ id: insertedId, threadId: 'thread-1', body: 'middle' });
  membershipFeed.insert({ scopeKey: 'thread-1', entityKey: insertedId, order: insertedOrder });
  membershipFeed.commit();
  entityFeed.commit();
  await settle();
  resultSubscription.unsubscribe();
  membershipSubscription.unsubscribe();

  const expectedIds = createMessages(size).map(row => row.id);
  expectedIds.splice(insertAfter + 1, 0, insertedId);
  const actualIds = reader.result().map(row => row.id);
  expect(actualIds).toEqual(expectedIds);
  let sameGapInsertLimit = 0;
  let remainingGap = orderStep;
  while (true) {
    const nextOrder = remainingGap / 2;
    if (nextOrder === 0) break;
    remainingGap = nextOrder;
    sameGapInsertLimit += 1;
  }

  const measurement = {
    size,
    resultChangedKeys: changedResultKeys.size,
    changedMembershipKeys: changedMembershipKeys.size,
    orderPreserved: JSON.stringify(actualIds) === JSON.stringify(expectedIds),
    sameGapInsertLimit
  };
  reader.unmount();
  return measurement;
};

describe('TanStack server-order scope spike', () => {
  it('measures an append with a mounted server-order reader at two scales', async () => {
    const measurements: Measurement[] = [];
    for (const size of [300, 3000]) {
      const baseline = await measureBaseline(size);
      resetRuntime();
      const tanstack = await measureTanStack(size);
      measurements.push({ baseline, tanstack });

      expect(baseline.commitBatches).toBe(1);
      expect(baseline.readerNotifications).toBe(1);
      expect(baseline.selectCalls).toBe(size * 2 + 2);
      expect(baseline.identityChanges).toBe(1);
      expect(baseline.scopeReadPasses).toBe(1);
      expect(baseline.scopeReadResorts).toBe(1);
      expect(tanstack.logicalSyncCommits).toBe(1);
      expect(tanstack.entitySyncWrites).toBe(1);
      expect(tanstack.membershipSyncWrites).toBe(1);
      expect(tanstack.resultChangedKeys).toBe(2);
      expect(tanstack.intermediateResultHasAppendedRow).toBe(false);
      expect(tanstack.readerNotifications).toBe(1);
      expect(tanstack.selectCalls).toBe(0);
      expect(tanstack.orderKeyCalls).toBe(0);
      expect(tanstack.identityChanges).toBe(1);
      expect(tanstack.liveQueryRuns).toBe(3);
    }

    console.info(JSON.stringify(measurements));
  });
});

describe('TanStack alias and sparse-order spikes', () => {
  it('measures server id binding at two scales', async () => {
    const measurements: ServerBindingMeasurement[] = [];
    for (const size of [300, 3000]) {
      const measurement = await measureServerBinding(size);
      measurements.push(measurement);

      expect(measurement.optimisticVisible).toBe(true);
      expect(measurement.resultChangedKeys).toBe(1);
      expect(measurement.targetPositionPreserved).toBe(true);
      expect(measurement.resultKeysPreserved).toBe(true);
      expect(measurement.neighborIdentityChanges).toBe(0);
      expect(measurement.duplicateServerIdChangedKeys).toBe(0);
      expect(measurement.duplicateServerIdKeepsKey).toBe(true);
      expect(measurement.deletedServerResurrectsEntity).toBe(true);
      expect(measurement.deletedServerVisibleInScope).toBe(false);
    }

    console.info(JSON.stringify(measurements));
  });

  it('measures sparse order insertion at two scales', async () => {
    const measurements: SparseOrderMeasurement[] = [];
    for (const size of [300, 3000]) {
      const measurement = await measureSparseOrder(size);
      measurements.push(measurement);

      expect(measurement.resultChangedKeys).toBe(2);
      expect(measurement.changedMembershipKeys).toBe(1);
      expect(measurement.orderPreserved).toBe(true);
      expect(measurement.sameGapInsertLimit).toBe(1084);
    }

    console.info(JSON.stringify(measurements));
  });
});
