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
  readerProjectionRows: number;
  readerChangedRows: number;
  scopeReadPasses: number;
  scopeReadResorts: number;
};

type TanStackMeasurement = {
  size: number;
  entitySyncWrites: number;
  membershipSyncWrites: number;
  readerNotifications: number;
  readerProjectionRows: number;
  readerChangedRows: number;
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

  append(value: T): void {
    const methods = this.methods;
    if (!methods) throw new Error('Sync feed is not connected');
    methods.begin();
    methods.write({ type: 'insert', value });
    methods.commit();
    this.writes += 1;
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

  let readerProjectionRows = 0;
  const reader = renderCounted(() => {
    const rows = messages.scopes.thread.use({ threadId: 'thread-1' });
    readerProjectionRows += rows.length;
    return rows;
  });
  await settle();
  const rendersBeforeAppend = reader.renders();
  readerProjectionRows = 0;
  diagnostics().reset();

  act(() => {
    messages.insert({ id: `message-${size}`, threadId: 'thread-1', body: `body-${size}` });
  });
  await settle();

  expect(reader.result().map(row => row.id)).toEqual(Array.from({ length: size + 1 }, (_, index) => `message-${index}`));
  const snapshot = diagnostics().snapshot();
  const measurement = {
    size,
    commitBatches: snapshot.commits,
    readerNotifications: reader.renders() - rendersBeforeAppend,
    readerProjectionRows,
    readerChangedRows: reader.result().length - size,
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
  membership.createIndex(row => row.scopeKey, { indexType: BasicIndex });
  const scopedMessages = createLiveQueryCollection({
    id: `spike-thread-${size}`,
    query: q =>
      q
        .from({ membership })
        .where(({ membership }) => eq(membership.scopeKey, 'thread-1'))
        .join({ entity: entities }, ({ membership, entity }) => eq(membership.entityKey, entity.id))
        .orderBy(({ membership }) => membership.order, 'asc')
        .select(({ membership, entity }) => ({ id: entity.id, order: membership.order }))
  });

  let readerProjectionRows = 0;
  const reader = renderCounted(() => {
    const { data } = useLiveQuery(scopedMessages);
    readerProjectionRows += data.length;
    return data;
  });
  await settle();
  expect(reader.result().map(row => row.id)).toEqual(Array.from({ length: size }, (_, index) => `message-${index}`));

  const runsBeforeAppend = scopedMessages.utils.getRunCount();
  const rendersBeforeAppend = reader.renders();
  readerProjectionRows = 0;
  entityFeed.append({ id: `message-${size}`, threadId: 'thread-1', body: `body-${size}` });
  membershipFeed.append({ scopeKey: 'thread-1', entityKey: `message-${size}`, order: size });
  await settle();

  expect(reader.result().map(row => row.id)).toEqual(Array.from({ length: size + 1 }, (_, index) => `message-${index}`));
  const measurement = {
    size,
    entitySyncWrites: entityFeed.writes,
    membershipSyncWrites: membershipFeed.writes,
    readerNotifications: reader.renders() - rendersBeforeAppend,
    readerProjectionRows,
    readerChangedRows: reader.result().length - size,
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
      expect(baseline.readerProjectionRows).toBe(size + 1);
      expect(baseline.readerChangedRows).toBe(1);
      expect(baseline.scopeReadPasses).toBe(1);
      expect(baseline.scopeReadResorts).toBe(1);
      expect(tanstack.entitySyncWrites).toBe(1);
      expect(tanstack.membershipSyncWrites).toBe(1);
      expect(tanstack.readerNotifications).toBe(1);
      expect(tanstack.readerProjectionRows).toBe(size + 1);
      expect(tanstack.readerChangedRows).toBe(1);
      expect(tanstack.liveQueryRuns).toBe(2);
    }

    console.info(JSON.stringify(measurements));
  });
});
