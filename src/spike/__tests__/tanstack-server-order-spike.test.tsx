import { BasicIndex, createCollection, createLiveQueryCollection, createTransaction, eq } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { act } from 'react-test-renderer';
import { defineModel, f, resetRuntime, scope } from '../../index';
import { diagnostics, renderCounted, settle, setupSpecRuntime } from '../../__tests__/spec/helpers/harness';

type MessageRow = { id: string; threadId: string; body: string };
type MembershipRow = { scopeKey: string; entityKey: string; order: number };
type StringMembershipRow = { scopeKey: string; entityKey: string; order: string };
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
  sameGapInsertions: number;
  sameGapOrderPreserved: boolean;
};
type FractionalDepthMeasurement = { insertions: number; orderPreserved: boolean };

const FRACTIONAL_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const fractionalKeyBetween = (lower: string | null, upper: string | null): string => {
  if (lower !== null && upper !== null && lower >= upper) throw new Error('Fractional keys must be ordered');
  const lowerValue = lower ?? '';
  const upperValue = upper ?? '';
  let prefix = '';
  let index = 0;
  while (true) {
    const lowerDigit = index < lowerValue.length ? FRACTIONAL_DIGITS.indexOf(lowerValue[index]!) : 0;
    const upperDigit = upper === null ? FRACTIONAL_DIGITS.length - 1 : index < upperValue.length ? FRACTIONAL_DIGITS.indexOf(upperValue[index]!) : FRACTIONAL_DIGITS.length - 1;
    if (lowerDigit === -1 || upperDigit === -1) throw new Error('Fractional key contains an unsupported digit');
    if (lowerDigit === upperDigit) {
      prefix += FRACTIONAL_DIGITS[lowerDigit];
      index += 1;
      continue;
    }
    if (upperDigit - lowerDigit > 1) return prefix + FRACTIONAL_DIGITS[Math.floor((lowerDigit + upperDigit) / 2)];
    return prefix + FRACTIONAL_DIGITS[lowerDigit] + fractionalKeyBetween(lowerValue.slice(index + 1) || null, null);
  }
};

type RecoveryEntityRow = { entityKey: string; threadId: string; body: string };
type RecoveryMembershipRow = { scopeKey: string; entityKey: string; order: string };
type RecoveryPlan = {
  entities: SyncMessage<RecoveryEntityRow>[];
  memberships: SyncMessage<RecoveryMembershipRow>[];
};
type JournalEnvelope<T> = { version: 1; id: string; state: 'pending' | 'applied'; plan: T };
type JournalRead<T> = { kind: 'valid'; envelope: JournalEnvelope<T> } | { kind: 'torn' };
type RecoveryMeasurement = {
  killPoint: 'journal' | 'entity' | 'both';
  beforeReadyRows: number;
  afterFirstCollectionRows: number;
  afterReplayRows: number;
  finalRows: number;
  consistent: boolean;
  markedApplied: boolean;
};
type JournalMeasurement = { recovery: RecoveryMeasurement[]; tornDetected: boolean };
type ParentRow = { id: string; childCount: number; touchVersion: number };
type ChildRow = { id: string; parentId: string };
type RelationSnapshot = { parents: ParentRow[]; children: ChildRow[] };
type RelationOperation =
  | { type: 'insert-child'; child: ChildRow }
  | { type: 'update-parent'; parent: ParentRow }
  | { type: 'delete-child'; id: string }
  | { type: 'delete-parent'; id: string };
type RelationPlan = { operations: RelationOperation[] };
type RelationMeasurement = {
  primaryAndEffectsVisibleTogether: boolean;
  visibleRows: number;
  visibleChildCount: number | null;
  visibleTouchVersion: number | null;
  readerNotifications: number;
  failedApplyLeavesNoRows: boolean;
  userCallbacks: number;
  cascadeOperationCount: number;
  journalApplied: boolean;
};

const journalChecksum = (value: string): string => {
  let checksum = 0;
  for (const character of value) checksum = (checksum + character.charCodeAt(0)) >>> 0;
  return checksum.toString(16);
};

class MemoryJournal<T> {
  private raw: string | null = null;

  write(id: string, plan: T): void {
    this.replace({ version: 1, id, state: 'pending', plan });
  }

  markApplied(): void {
    const record = this.read();
    if (record.kind !== 'valid') throw new Error('Cannot mark a torn journal record as applied');
    this.replace({ ...record.envelope, state: 'applied' });
  }

  read(): JournalRead<T> {
    if (!this.raw) return { kind: 'torn' };
    const separator = this.raw.indexOf(':');
    if (separator === -1) return { kind: 'torn' };
    const checksum = this.raw.slice(0, separator);
    const payload = this.raw.slice(separator + 1);
    if (journalChecksum(payload) !== checksum) return { kind: 'torn' };
    try {
      const envelope = JSON.parse(payload) as JournalEnvelope<T>;
      if (envelope.version !== 1 || !envelope.id || !envelope.state) return { kind: 'torn' };
      return { kind: 'valid', envelope };
    } catch {
      return { kind: 'torn' };
    }
  }

  tear(): void {
    if (!this.raw) throw new Error('Cannot tear an empty journal');
    this.raw = this.raw.slice(0, -1);
  }

  private replace(envelope: JournalEnvelope<T>): void {
    const payload = JSON.stringify(envelope);
    this.raw = `${journalChecksum(payload)}:${payload}`;
  }
}

class DelayedSyncFeed<T extends object> {
  private methods: SyncMethods<T> | null = null;

  sync = (methods: SyncMethods<T>): (() => void) => {
    this.methods = methods;
    return () => {
      if (this.methods === methods) this.methods = null;
    };
  };

  apply(operations: readonly SyncMessage<T>[]): void {
    const methods = this.requireMethods();
    methods.begin();
    for (const operation of operations) methods.write(operation);
    methods.commit();
  }

  markReady(): void {
    this.requireMethods().markReady();
  }

  private requireMethods(): SyncMethods<T> {
    if (!this.methods) throw new Error('Delayed sync feed is not connected');
    return this.methods;
  }
}

const planRelationEffects = (snapshot: RelationSnapshot, operation: { type: 'insert-child'; child: ChildRow } | { type: 'delete-parent'; id: string }): RelationPlan => {
  if (operation.type === 'insert-child') {
    const parent = snapshot.parents.find(candidate => candidate.id === operation.child.parentId);
    if (!parent) throw new Error('Parent is required for child insertion');
    return {
      operations: [
        operation,
        { type: 'update-parent', parent: { ...parent, childCount: parent.childCount + 1, touchVersion: parent.touchVersion + 1 } }
      ]
    };
  }
  return {
    operations: [
      ...snapshot.children.filter(child => child.parentId === operation.id).map(child => ({ type: 'delete-child' as const, id: child.id })),
      operation
    ]
  };
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
  const duplicateServerIdKeepsKey = aliases.get(serverId) === entityKey && entities.has(entityKey);

  membershipFeed.begin();
  membershipFeed.delete(`${optimisticMembership.scopeKey}:${entityKey}`);
  membershipFeed.commit();
  entityFeed.begin();
  entityFeed.delete(entityKey);
  entityFeed.commit();
  await settle();
  expect(reader.result().some(row => row.entityKey === entityKey)).toBe(false);
  const tombstones = new Set([entityKey]);
  const lateServerEntityKey = aliases.get(serverId);
  const lateServerResolution = lateServerEntityKey && !tombstones.has(lateServerEntityKey)
    ? { kind: 'matched' as const, entityKey: lateServerEntityKey }
    : { kind: 'unmatched' as const, entityKey: lateServerEntityKey };
  expect(lateServerResolution.kind).toBe('unmatched');
  if (lateServerResolution.kind === 'matched') {
    entityFeed.begin();
    entityFeed.update({ entityKey: lateServerResolution.entityKey!, clientId, serverId, threadId: 'thread-1', body: 'late-server-node' });
    entityFeed.commit();
  }
  await settle();

  const measurement = {
    size,
    optimisticVisible: optimisticTargetPosition !== -1,
    resultChangedKeys: changedResultKeys.size,
    targetPositionPreserved: boundTargetPosition === optimisticTargetPosition,
    resultKeysPreserved: JSON.stringify(boundResultKeys) === JSON.stringify(optimisticResultKeys),
    neighborIdentityChanges,
    duplicateServerIdChangedKeys: duplicateChangedResultKeys.size,
    duplicateServerIdKeepsKey,
    deletedServerResurrectsEntity: entities.has(entityKey),
    deletedServerVisibleInScope: reader.result().some(row => row.entityKey === entityKey)
  };
  reader.unmount();
  return measurement;
};

const measureSparseOrder = async (size: number): Promise<SparseOrderMeasurement> => {
  const initialMessages = createMessages(size);
  const entityFeed = new SyncFeed<MessageRow>(initialMessages);
  const membershipFeed = new SyncFeed<StringMembershipRow>(initialMessages.map((message, index) => ({
    scopeKey: message.threadId,
    entityKey: message.id,
    order: index.toString(36).padStart(4, '0')
  })));
  const entities = createCollection<MessageRow>({
    id: `sparse-entities-${size}`,
    getKey: row => row.id,
    startSync: true,
    sync: { sync: entityFeed.sync }
  });
  const membership = createCollection<StringMembershipRow>({
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
        .orderBy(({ membership }) => membership.order, { direction: 'asc', stringSort: 'lexical' })
        .select(({ membership, entity }) => ({ id: entity.id, order: membership.order }))
  });
  const reader = renderCounted(() => useLiveQuery(scopedMessages).data);
  await settle();

  const insertAfter = Math.floor(size / 2) - 1;
  const insertedId = `message-middle-${size}`;
  const insertedOrder = fractionalKeyBetween(
    insertAfter.toString(36).padStart(4, '0'),
    (insertAfter + 1).toString(36).padStart(4, '0')
  );
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
  let lowerKey = insertAfter.toString(36).padStart(4, '0');
  const upperKey = (insertAfter + 1).toString(36).padStart(4, '0');
  const sameGapKeys: string[] = [];
  for (let index = 0; index < 5000; index += 1) {
    lowerKey = fractionalKeyBetween(lowerKey, upperKey);
    sameGapKeys.push(lowerKey);
  }

  const measurement = {
    size,
    resultChangedKeys: changedResultKeys.size,
    changedMembershipKeys: changedMembershipKeys.size,
    orderPreserved: JSON.stringify(actualIds) === JSON.stringify(expectedIds),
    sameGapInsertions: sameGapKeys.length,
    sameGapOrderPreserved: sameGapKeys.every((key, index) => index === 0 || sameGapKeys[index - 1]! < key) && sameGapKeys.every(key => key < upperKey)
  };
  reader.unmount();
  return measurement;
};

const measureFractionalOrderDepth = async (): Promise<FractionalDepthMeasurement> => {
  const entityFeed = new SyncFeed<MessageRow>([
    { id: 'lower-bound', threadId: 'thread-1', body: 'lower' },
    { id: 'upper-bound', threadId: 'thread-1', body: 'upper' }
  ]);
  const membershipFeed = new SyncFeed<StringMembershipRow>([
    { scopeKey: 'thread-1', entityKey: 'lower-bound', order: '0000' },
    { scopeKey: 'thread-1', entityKey: 'upper-bound', order: '0001' }
  ]);
  const entities = createCollection<MessageRow>({
    id: 'fractional-depth-entities',
    getKey: row => row.id,
    startSync: true,
    sync: { sync: entityFeed.sync }
  });
  const membership = createCollection<StringMembershipRow>({
    id: 'fractional-depth-membership',
    getKey: row => `${row.scopeKey}:${row.entityKey}`,
    startSync: true,
    sync: { sync: membershipFeed.sync }
  });
  entities.createIndex(row => row.id, { indexType: BasicIndex });
  membership.createIndex(row => row.scopeKey, { indexType: BasicIndex });
  const scopedMessages = createLiveQueryCollection({
    id: 'fractional-depth-thread',
    query: q =>
      q
        .from({ membership })
        .where(({ membership }) => eq(membership.scopeKey, 'thread-1'))
        .join({ entity: entities }, ({ membership, entity }) => eq(membership.entityKey, entity.id))
        .orderBy(({ membership }) => membership.order, { direction: 'asc', stringSort: 'lexical' })
        .select(({ entity }) => ({ id: entity.id }))
  });
  const reader = renderCounted(() => useLiveQuery(scopedMessages).data);
  await settle();
  const insertedIds: string[] = [];
  let lowerKey = '0000';
  const upperKey = '0001';
  entityFeed.begin();
  membershipFeed.begin();
  for (let index = 0; index < 5000; index += 1) {
    const id = `same-gap-${index}`;
    lowerKey = fractionalKeyBetween(lowerKey, upperKey);
    insertedIds.push(id);
    entityFeed.insert({ id, threadId: 'thread-1', body: id });
    membershipFeed.insert({ scopeKey: 'thread-1', entityKey: id, order: lowerKey });
  }
  membershipFeed.commit();
  entityFeed.commit();
  await settle();
  const expectedIds = ['lower-bound', ...insertedIds, 'upper-bound'];
  const actualIds = reader.result().map(row => row.id);
  const measurement = {
    insertions: insertedIds.length,
    orderPreserved: JSON.stringify(actualIds) === JSON.stringify(expectedIds)
  };
  reader.unmount();
  return measurement;
};

const createRecoveryPlan = (): RecoveryPlan => ({
  entities: [{ type: 'insert', value: { entityKey: 'recovery-entity', threadId: 'thread-1', body: 'recovered' } }],
  memberships: [{ type: 'insert', value: { scopeKey: 'thread-1', entityKey: 'recovery-entity', order: 'U' } }]
});

const applyCrashPrefix = (plan: RecoveryPlan, killPoint: RecoveryMeasurement['killPoint']): void => {
  if (killPoint === 'journal') return;
  const entityFeed = new DelayedSyncFeed<RecoveryEntityRow>();
  const membershipFeed = new DelayedSyncFeed<RecoveryMembershipRow>();
  createCollection<RecoveryEntityRow>({
    id: `crash-entities-${killPoint}`,
    getKey: row => row.entityKey,
    startSync: true,
    sync: { sync: entityFeed.sync }
  });
  createCollection<RecoveryMembershipRow>({
    id: `crash-membership-${killPoint}`,
    getKey: row => `${row.scopeKey}:${row.entityKey}`,
    startSync: true,
    sync: { sync: membershipFeed.sync }
  });
  entityFeed.apply(plan.entities);
  if (killPoint === 'both') membershipFeed.apply(plan.memberships);
};

const recoverJournal = async (journal: MemoryJournal<RecoveryPlan>, killPoint: RecoveryMeasurement['killPoint']): Promise<RecoveryMeasurement> => {
  const entityFeed = new DelayedSyncFeed<RecoveryEntityRow>();
  const membershipFeed = new DelayedSyncFeed<RecoveryMembershipRow>();
  const entities = createCollection<RecoveryEntityRow>({
    id: `recovery-entities-${killPoint}`,
    getKey: row => row.entityKey,
    startSync: true,
    sync: { sync: entityFeed.sync }
  });
  const membership = createCollection<RecoveryMembershipRow>({
    id: `recovery-membership-${killPoint}`,
    getKey: row => `${row.scopeKey}:${row.entityKey}`,
    startSync: true,
    sync: { sync: membershipFeed.sync }
  });
  entities.createIndex(row => row.entityKey, { indexType: BasicIndex });
  membership.createIndex(row => row.scopeKey, { indexType: BasicIndex });
  const scopedMessages = createLiveQueryCollection({
    id: `recovery-thread-${killPoint}`,
    query: q =>
      q
        .from({ membership })
        .where(({ membership }) => eq(membership.scopeKey, 'thread-1'))
        .join({ entity: entities }, ({ membership, entity }) => eq(membership.entityKey, entity.entityKey))
        .orderBy(({ membership }) => membership.order, 'asc')
        .select(({ entity }) => ({ entityKey: entity.entityKey, body: entity.body }))
  });
  const reader = renderCounted(() => useLiveQuery(scopedMessages).data);
  await settle();
  const beforeReadyRows = reader.result().length;
  const record = journal.read();
  if (record.kind !== 'valid' || record.envelope.state !== 'pending') throw new Error('Recovery requires a pending journal envelope');
  entityFeed.apply(record.envelope.plan.entities);
  await settle();
  const afterFirstCollectionRows = reader.result().length;
  membershipFeed.apply(record.envelope.plan.memberships);
  await settle();
  const afterReplayRows = reader.result().length;
  const readyBeforeMark = entities.isReady() || membership.isReady();
  journal.markApplied();
  entityFeed.markReady();
  membershipFeed.markReady();
  await settle();
  const finalRows = reader.result().length;
  const completedRecord = journal.read();
  const markedApplied = completedRecord.kind === 'valid' && completedRecord.envelope.state === 'applied';
  const measurement = {
    killPoint,
    beforeReadyRows,
    afterFirstCollectionRows,
    afterReplayRows,
    finalRows,
    consistent: afterFirstCollectionRows === 0 && finalRows === 1 && entities.size === 1 && membership.size === 1 && !readyBeforeMark,
    markedApplied
  };
  reader.unmount();
  return measurement;
};

const measureJournalRecovery = async (): Promise<JournalMeasurement> => {
  const recovery: RecoveryMeasurement[] = [];
  for (const killPoint of ['journal', 'entity', 'both'] as const) {
    const journal = new MemoryJournal<RecoveryPlan>();
    const plan = createRecoveryPlan();
    journal.write(`recovery-${killPoint}`, plan);
    applyCrashPrefix(plan, killPoint);
    recovery.push(await recoverJournal(journal, killPoint));
  }
  const tornJournal = new MemoryJournal<RecoveryPlan>();
  tornJournal.write('torn-envelope', createRecoveryPlan());
  tornJournal.tear();
  return { recovery, tornDetected: tornJournal.read().kind === 'torn' };
};

const measureRelationPlan = async (): Promise<RelationMeasurement> => {
  const parent = { id: 'parent-1', childCount: 0, touchVersion: 0 };
  const child = { id: 'child-1', parentId: parent.id };
  const snapshot = { parents: [parent], children: [] };
  const plan = planRelationEffects(snapshot, { type: 'insert-child', child });
  const cascadePlan = planRelationEffects(
    { parents: [parent], children: [{ id: 'child-1', parentId: parent.id }, { id: 'child-2', parentId: parent.id }] },
    { type: 'delete-parent', id: parent.id }
  );
  const journal = new MemoryJournal<RelationPlan>();
  journal.write('relation-insert', plan);
  let userCallbacks = 0;
  const parentFeed = new SyncFeed<ParentRow>([parent]);
  const childFeed = new SyncFeed<ChildRow>([]);
  const parents = createCollection<ParentRow>({
    id: 'relation-parents',
    getKey: row => row.id,
    startSync: true,
    sync: { sync: parentFeed.sync },
    onUpdate: async () => {
      userCallbacks += 1;
    }
  });
  const children = createCollection<ChildRow>({
    id: 'relation-children',
    getKey: row => row.id,
    startSync: true,
    sync: { sync: childFeed.sync },
    onInsert: async () => {
      userCallbacks += 1;
    }
  });
  parents.createIndex(row => row.id, { indexType: BasicIndex });
  children.createIndex(row => row.parentId, { indexType: BasicIndex });
  const scopedChildren = createLiveQueryCollection({
    id: 'relation-children-with-parent',
    query: q =>
      q
        .from({ child: children })
        .join({ parent: parents }, ({ child, parent }) => eq(child.parentId, parent.id))
        .select(({ child, parent }) => ({ childId: child.id, childCount: parent.childCount, touchVersion: parent.touchVersion }))
  });
  const reader = renderCounted(() => useLiveQuery(scopedChildren).data);
  await settle();
  const rendersBeforeApply = reader.renders();
  const transaction = createTransaction({
    mutationFn: async () => {
      childFeed.begin();
      childFeed.insert(child);
      childFeed.commit();
      parentFeed.begin();
      parentFeed.update({ id: parent.id, childCount: 1, touchVersion: 1 });
      parentFeed.commit();
      journal.markApplied();
      return { operationCount: plan.operations.length };
    }
  });
  transaction.mutate(() => {
    for (const operation of plan.operations) {
      if (operation.type === 'insert-child') children.insert(operation.child);
      if (operation.type === 'update-parent') {
        parents.update(operation.parent.id, draft => {
          draft.childCount = operation.parent.childCount;
          draft.touchVersion = operation.parent.touchVersion;
        });
      }
    }
  });
  await transaction.isPersisted.promise;
  await settle();
  const appliedRows = reader.result();
  const completedJournal = journal.read();
  const readerNotifications = reader.renders() - rendersBeforeApply;
  const primaryAndEffectsVisibleTogether = appliedRows.length === 1
    && appliedRows[0]?.childId === child.id
    && appliedRows[0]?.childCount === 1
    && appliedRows[0]?.touchVersion === 1
    && readerNotifications === 1;
  reader.unmount();

  const failedParentFeed = new SyncFeed<ParentRow>([parent]);
  const failedChildFeed = new SyncFeed<ChildRow>([]);
  const failedParents = createCollection<ParentRow>({
    id: 'relation-failed-parents',
    getKey: row => row.id,
    startSync: true,
    sync: { sync: failedParentFeed.sync },
    onUpdate: async () => {
      userCallbacks += 1;
    }
  });
  const failedChildren = createCollection<ChildRow>({
    id: 'relation-failed-children',
    getKey: row => row.id,
    startSync: true,
    sync: { sync: failedChildFeed.sync },
    onInsert: async () => {
      userCallbacks += 1;
    }
  });
  failedParents.createIndex(row => row.id, { indexType: BasicIndex });
  failedChildren.createIndex(row => row.parentId, { indexType: BasicIndex });
  const failedScopedChildren = createLiveQueryCollection({
    id: 'relation-failed-children-with-parent',
    query: q =>
      q
        .from({ child: failedChildren })
        .join({ parent: failedParents }, ({ child, parent }) => eq(child.parentId, parent.id))
        .select(({ child, parent }) => ({ childId: child.id, childCount: parent.childCount, touchVersion: parent.touchVersion }))
  });
  const failedReader = renderCounted(() => useLiveQuery(failedScopedChildren).data);
  await settle();
  const failedJournal = new MemoryJournal<RelationPlan>();
  failedJournal.write('relation-failed', plan);
  const failedTransaction = createTransaction({
    mutationFn: async () => {
      throw new Error('envelope apply failed');
    }
  });
  failedTransaction.mutate(() => {
    failedChildren.insert(child);
    failedParents.update(parent.id, draft => {
      draft.childCount = 1;
      draft.touchVersion = 1;
    });
  });
  await expect(failedTransaction.isPersisted.promise).rejects.toThrow('envelope apply failed');
  await settle();
  const failedApplyLeavesNoRows = failedReader.result().length === 0
    && failedParents.get(parent.id)?.childCount === 0
    && failedParents.get(parent.id)?.touchVersion === 0
    && !failedChildren.has(child.id);
  failedReader.unmount();
  return {
    primaryAndEffectsVisibleTogether,
    visibleRows: appliedRows.length,
    visibleChildCount: appliedRows[0]?.childCount ?? null,
    visibleTouchVersion: appliedRows[0]?.touchVersion ?? null,
    readerNotifications,
    failedApplyLeavesNoRows,
    userCallbacks,
    cascadeOperationCount: cascadePlan.operations.length,
    journalApplied: completedJournal.kind === 'valid' && completedJournal.envelope.state === 'applied'
  };
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
      expect(measurement.deletedServerResurrectsEntity).toBe(false);
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
      expect(measurement.sameGapInsertions).toBe(5000);
      expect(measurement.sameGapOrderPreserved).toBe(true);
    }

    console.info(JSON.stringify(measurements));
  });

  it('keeps 5000 same-gap fractional insertions ordered', async () => {
    const measurement = await measureFractionalOrderDepth();
    console.info(JSON.stringify(measurement));
    expect(measurement.insertions).toBe(5000);
    expect(measurement.orderPreserved).toBe(true);
  });
});

describe('TanStack durable envelope and relation-plan spikes', () => {
  it('recovers every pending envelope after a simulated process kill', async () => {
    const measurement = await measureJournalRecovery();
    expect(measurement.tornDetected).toBe(true);
    for (const recovery of measurement.recovery) {
      expect(recovery.beforeReadyRows).toBe(0);
      expect(recovery.afterFirstCollectionRows).toBe(0);
      expect(recovery.afterReplayRows).toBe(1);
      expect(recovery.finalRows).toBe(1);
      expect(recovery.consistent).toBe(true);
      expect(recovery.markedApplied).toBe(true);
    }

    console.info(JSON.stringify(measurement));
  });

  it('applies relation effects as an envelope plan without callbacks', async () => {
    const measurement = await measureRelationPlan();
    console.info(JSON.stringify(measurement));
    expect(measurement.primaryAndEffectsVisibleTogether).toBe(true);
    expect(measurement.failedApplyLeavesNoRows).toBe(true);
    expect(measurement.userCallbacks).toBe(0);
    expect(measurement.cascadeOperationCount).toBe(3);
    expect(measurement.journalApplied).toBe(true);

  });
});
