import { BasicIndex, createCollection, createLiveQueryCollection, eq } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { act } from 'react-test-renderer';
import { defineModel, f, resetRuntime, scope } from '../../index';
import { diagnostics, renderCounted, settle, setupSpecRuntime } from '../../__tests__/spec/helpers/harness';

type MessageRow = { id: string; threadId: string; body: string };
type MembershipRow = { scopeKey: string; entityKey: string; order: number };
type ScopeValue = { threadId: string };
type SyncMessage<T extends object> = { type: 'insert'; value: T };
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
  readerNotifications: number;
  selectCalls: number;
  orderKeyCalls: number;
  comparatorCalls: null;
  identityChanges: number;
  liveQueryRuns: number;
};

type Measurement = { baseline: BaselineMeasurement; tanstack: TanStackMeasurement };

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

  write(value: T): void {
    const methods = this.methods;
    if (!methods) throw new Error('Sync feed is not connected');
    methods.write({ type: 'insert', value });
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

  append(entity: MessageRow, membership: MembershipRow): void {
    this.entityFeed.begin();
    this.membershipFeed.begin();
    this.entityFeed.write(entity);
    this.membershipFeed.write(membership);
    this.entityFeed.commit();
    this.membershipFeed.commit();
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
  const append = new SyncAppendTransaction(entityFeed, membershipFeed);
  append.append(
    { id: `message-${size}`, threadId: 'thread-1', body: `body-${size}` },
    { scopeKey: 'thread-1', entityKey: `message-${size}`, order: size }
  );
  await settle();

  const nextRows = reader.result();
  expect(nextRows.map(row => row.id)).toEqual(Array.from({ length: size + 1 }, (_, index) => `message-${index}`));
  const measurement = {
    size,
    logicalSyncCommits: append.commits,
    entitySyncWrites: entityFeed.writes,
    membershipSyncWrites: membershipFeed.writes,
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
      expect(tanstack.readerNotifications).toBe(1);
      expect(tanstack.selectCalls).toBe(0);
      expect(tanstack.orderKeyCalls).toBe(0);
      expect(tanstack.identityChanges).toBe(1);
      expect(tanstack.liveQueryRuns).toBe(3);
    }

    console.info(JSON.stringify(measurements));
  });
});
