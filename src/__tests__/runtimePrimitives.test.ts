import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  configureDb,
  createKeyedBatchBuffer,
  createNestedObjectPatcher,
  createThrottledSingleFlight,
  defineModel,
  pruneExpiredRows,
  pruneOrphanedRows,
  reconcileOptimisticRows,
  resolveStaleTempRows,
  singletonStatics,
  trimRowsPerScope,
  type StoragePlane
} from '../index';
import { createIdArrayPatcher, createKeyedArrayPatcher } from '../utils/runtimePrimitives';
import { defineShape } from '../schema/shape';
import { f } from '../schema/f';
import { mockTransport } from './helpers/testRuntime';

const reactionShape = defineShape<{ id?: unknown; kind?: unknown; count?: unknown }>()({
  id: f.id(),
  kind: f.str().nullDefault(),
  count: f.num().nullDefault()
});

const createMemoryStorage = (): StoragePlane => {
  const values = new Map<string, string>();
  return {
    get: key => values.get(key),
    set: entries => {
      for (const entry of entries) {
        if (entry.value === null) values.delete(entry.key);
        else values.set(entry.key, entry.value);
      }
    },
    keys: prefix => [...values.keys()].filter(key => key.startsWith(prefix))
  };
};

const configureMemoryDb = (): void => {
  configureDb({ storage: createMemoryStorage(), transport: mockTransport({}) });
};

const renderHook = <T,>(read: () => T): { current: T; unmount: () => void } => {
  let current!: T;
  const Harness = () => {
    current = read();
    return null;
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(Harness));
  });
  return { get current() { return current; }, unmount: () => renderer.unmount() };
};

type MessageRow = {
  id: string;
  chatId: string;
  userId: string;
  body: string;
  createdAt: string;
  status: string | null;
  sequenceNumber: number | null;
};

const createMessageModel = (id: string) =>
  defineModel({
    id,
    name: `RuntimeMessageModel:${id}`,
    fields: {
      chatId: f.str(),
      userId: f.str(),
      body: f.str(),
      createdAt: f.str(),
      status: f.str().nullable(),
      sequenceNumber: f.num().nullable()
    }
  });

const message = (input: Partial<MessageRow> & Pick<MessageRow, 'id' | 'createdAt'>): MessageRow => ({
  chatId: 'chat-1',
  userId: 'user-1',
  body: 'hello',
  status: null,
  sequenceNumber: null,
  ...input
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('runtime primitives', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    configureDb({ transport: mockTransport({}) });
  });

  it('flushes keyed batch buckets with independent trailing timers', () => {
    jest.useFakeTimers();
    const onFlush = jest.fn();
    const buffer = createKeyedBatchBuffer<{ key: string; id: string }>({
      keyOf: item => item.key,
      flushMs: 100,
      onFlush
    });

    buffer.push({ key: 'a', id: 'a1' });
    jest.advanceTimersByTime(60);
    buffer.push({ key: 'b', id: 'b1' });
    jest.advanceTimersByTime(39);

    expect(onFlush).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenLastCalledWith('a', [{ key: 'a', id: 'a1' }]);

    jest.advanceTimersByTime(60);

    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenLastCalledWith('b', [{ key: 'b', id: 'b1' }]);
  });

  it('restarts a keyed batch timer for later pushes into the same bucket', () => {
    jest.useFakeTimers();
    const onFlush = jest.fn();
    const buffer = createKeyedBatchBuffer<{ key: string; id: string }>({
      keyOf: item => item.key,
      flushMs: 100,
      onFlush
    });

    buffer.push({ key: 'a', id: 'a1' });
    jest.advanceTimersByTime(80);
    buffer.push({ key: 'a', id: 'a2' });
    jest.advanceTimersByTime(99);

    expect(onFlush).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);

    expect(onFlush).toHaveBeenCalledWith('a', [
      { key: 'a', id: 'a1' },
      { key: 'a', id: 'a2' }
    ]);
  });

  it('flushes a capped keyed batch synchronously and clears its timer', () => {
    jest.useFakeTimers();
    const onFlush = jest.fn();
    const buffer = createKeyedBatchBuffer<{ key: string; id: string }>({
      keyOf: item => item.key,
      flushMs: 100,
      maxSize: 2,
      onFlush
    });

    buffer.push({ key: 'a', id: 'a1' });
    buffer.push({ key: 'a', id: 'a2' });

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith('a', [
      { key: 'a', id: 'a1' },
      { key: 'a', id: 'a2' }
    ]);

    jest.advanceTimersByTime(100);

    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it('dedupes keyed batch items with newest-wins replacement while preserving distinct id order', () => {
    jest.useFakeTimers();
    const onFlush = jest.fn();
    const buffer = createKeyedBatchBuffer<{ key: string; id: string; version: number }>({
      keyOf: item => item.key,
      flushMs: 100,
      dedupe: {
        idOf: item => item.id,
        isNewer: (candidate, existing) => candidate.version > existing.version
      },
      onFlush
    });

    buffer.push({ key: 'a', id: 'first', version: 1 });
    buffer.push({ key: 'a', id: 'second', version: 1 });
    buffer.push({ key: 'a', id: 'first', version: 0 });
    buffer.push({ key: 'a', id: 'first', version: 2 });
    buffer.flushAll();

    expect(onFlush).toHaveBeenCalledWith('a', [
      { key: 'a', id: 'first', version: 2 },
      { key: 'a', id: 'second', version: 1 }
    ]);
  });

  it('flushes all buckets, clears without firing, and contains flush errors', () => {
    jest.useFakeTimers();
    const error = new Error('boom');
    const onFlush = jest.fn((key: string) => {
      if (key === 'bad') throw error;
    });
    const logger = { debug: jest.fn(), error: jest.fn() };
    configureDb({ transport: mockTransport({}), logger });
    const buffer = createKeyedBatchBuffer<{ key: string; id: string }>({
      keyOf: item => item.key,
      flushMs: 100,
      onFlush
    });

    buffer.push({ key: 'good', id: 'g1' });
    buffer.push({ key: 'bad', id: 'b1' });
    buffer.flushAll();

    expect(onFlush).toHaveBeenCalledWith('good', [{ key: 'good', id: 'g1' }]);
    expect(onFlush).toHaveBeenCalledWith('bad', [{ key: 'bad', id: 'b1' }]);
    expect(logger.error).toHaveBeenCalledWith('db', 'keyed batch buffer flush failed', { key: 'bad', error });

    buffer.push({ key: 'clear', id: 'c1' });
    buffer.clear();
    jest.advanceTimersByTime(100);

    expect(onFlush).toHaveBeenCalledTimes(2);
  });

  it('reconciles optimistic rows by scoped candidates, content match, window, best delta, and existing server ids', () => {
    configureMemoryDb();
    const model = createMessageModel('runtime-reconcile-main');
    model.insertStored(message({ id: 'server-existing', createdAt: '2026-01-01T00:00:00.000Z' }));
    model.insertStored(message({ id: 'temp-old', createdAt: '2026-01-01T00:00:02.000Z' }));
    model.insertStored(message({ id: 'temp-best', createdAt: '2026-01-01T00:00:09.000Z' }));
    model.insertStored(message({ id: 'temp-outside-window', body: 'window', createdAt: '2026-01-01T00:03:00.000Z' }));
    const commit = jest.fn();

    const unmatched = reconcileOptimisticRows(
      model,
      [
        message({ id: 'server-1', createdAt: '2026-01-01T00:00:10.000Z' }),
        message({ id: 'server-window', body: 'window', createdAt: '2026-01-01T00:00:00.000Z' }),
        message({ id: 'server-existing', createdAt: '2026-01-01T00:00:00.000Z' }),
        message({ id: 'server-unmatched', body: 'other', createdAt: '2026-01-01T00:00:00.000Z' })
      ],
      {
        resolveCandidates: { fields: ['chatId', 'userId'] },
        match: (candidate, node) => candidate.body.trim() === node.body.trim(),
        createdAtWindowMs: 60_000,
        commit
      }
    );

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('temp-best', expect.objectContaining({ id: 'server-1' }));
    expect(unmatched.map(row => row.id)).toEqual(['server-window', 'server-unmatched']);
  });

  it('allows custom optimistic candidate predicates in addition to temp ids', () => {
    configureMemoryDb();
    const model = createMessageModel('runtime-reconcile-custom');
    model.insertStored(message({ id: 'local-sending', status: 'sending', createdAt: '2026-01-01T00:00:00.000Z' }));
    const commit = jest.fn();

    const unmatched = reconcileOptimisticRows(model, [message({ id: 'server-1', createdAt: '2026-01-01T00:00:01.000Z' })], {
      resolveCandidates: node => model.getWhere({ chatId: node.chatId }),
      isCandidate: candidate => candidate.status === 'sending',
      match: (candidate, node) => candidate.body === node.body,
      createdAtWindowMs: 60_000,
      commit
    });

    expect(unmatched).toEqual([]);
    expect(commit).toHaveBeenCalledWith('local-sending', expect.objectContaining({ id: 'server-1' }));
  });

  it('drops an existing-id node by default (onExisting unset) - neither returned nor committed', () => {
    configureMemoryDb();
    const model = createMessageModel('runtime-reconcile-existing-drop');
    model.insertStored(message({ id: 'already-applied', createdAt: '2026-01-01T00:00:00.000Z' }));
    const commit = jest.fn();

    const unmatched = reconcileOptimisticRows(model, [message({ id: 'already-applied', createdAt: '2026-01-01T00:00:00.000Z' })], {
      resolveCandidates: { fields: ['chatId', 'userId'] },
      match: (candidate, node) => candidate.body === node.body,
      commit
    });

    expect(unmatched).toEqual([]);
    expect(commit).not.toHaveBeenCalled();
  });

  it("onExisting: 'return' surfaces a subscription echo of an already-applied row instead of dropping it", () => {
    configureMemoryDb();
    const model = createMessageModel('runtime-reconcile-existing-return');
    model.insertStored(message({ id: 'already-applied', createdAt: '2026-01-01T00:00:00.000Z' }));
    model.insertStored(message({ id: 'temp-1', createdAt: '2026-01-01T00:00:01.000Z' }));
    const commit = jest.fn();

    const unmatched = reconcileOptimisticRows(
      model,
      [
        message({ id: 'already-applied', body: 'echoed', createdAt: '2026-01-01T00:00:00.000Z' }),
        message({ id: 'server-1', createdAt: '2026-01-01T00:00:02.000Z' })
      ],
      {
        resolveCandidates: { fields: ['chatId', 'userId'] },
        match: (candidate, node) => candidate.body === node.body,
        createdAtWindowMs: 60_000,
        commit,
        onExisting: 'return'
      }
    );

    expect(unmatched.map(row => row.id)).toEqual(['already-applied']);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('temp-1', expect.objectContaining({ id: 'server-1' }));
  });

  it('prunes orphaned rows with a batched destroyMany call', () => {
    configureMemoryDb();
    const model = defineModel({
      id: 'runtime-orphans',
      name: 'RuntimeOrphanModel',
      fields: { momentId: f.str() }
    });
    model.insertStored({ id: 'join-1', momentId: 'moment-1' });
    model.insertStored({ id: 'join-2', momentId: 'moment-missing' });
    model.insertStored({ id: 'join-3', momentId: 'moment-missing-2' });
    const destroyMany = jest.spyOn(model, 'destroyMany');

    expect(pruneOrphanedRows(model, 'momentId', new Set(['moment-1']))).toBe(2);
    expect(destroyMany).toHaveBeenCalledWith(['join-2', 'join-3']);
    expect(model.getAll().map(row => row.id)).toEqual(['join-1']);
  });

  it('prunes rows older than ttl while keeping boundary and invalid timestamps', () => {
    configureMemoryDb();
    const model = createMessageModel('runtime-expired');
    model.insertStored(message({ id: 'expired', createdAt: '2026-01-01T00:00:00.000Z' }));
    model.insertStored(message({ id: 'boundary', createdAt: '2026-01-01T00:01:00.000Z' }));
    model.insertStored(message({ id: 'fresh', createdAt: '2026-01-01T00:01:01.000Z' }));
    model.insertStored(message({ id: 'invalid', createdAt: 'not-a-date' }));
    const destroyMany = jest.spyOn(model, 'destroyMany');

    expect(pruneExpiredRows(model, 'createdAt', 60_000, '2026-01-01T00:02:00.000Z')).toBe(1);
    expect(destroyMany).toHaveBeenCalledWith(['expired']);
    expect(model.getAll().map(row => row.id).sort()).toEqual(['boundary', 'fresh', 'invalid']);
  });

  it('trims newest rows per scope while excluding protected rows from the limit', () => {
    configureMemoryDb();
    const model = createMessageModel('runtime-trim');
    model.insertStored(message({ id: 'old-protected', createdAt: '2026-01-01T00:00:00.000Z', sequenceNumber: 1 }));
    model.insertStored(message({ id: 'new-1', createdAt: '2026-01-01T00:00:03.000Z', sequenceNumber: 4 }));
    model.insertStored(message({ id: 'new-2', createdAt: '2026-01-01T00:00:02.000Z', sequenceNumber: 3 }));
    model.insertStored(message({ id: 'old-delete', createdAt: '2026-01-01T00:00:01.000Z', sequenceNumber: 2 }));
    const destroyMany = jest.spyOn(model, 'destroyMany');

    expect(trimRowsPerScope(model, 'chatId', 2, (left, right) => (right.sequenceNumber ?? 0) - (left.sequenceNumber ?? 0), new Set(['old-protected']))).toBe(1);
    expect(destroyMany).toHaveBeenCalledWith(['old-delete']);
    expect(model.getAll().map(row => row.id).sort()).toEqual(['new-1', 'new-2', 'old-protected']);
  });

  it('resolves stale temp rows by age while skipping protected and non-temp rows', () => {
    configureMemoryDb();
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-01-01T00:02:00.000Z').getTime());
    const model = createMessageModel('runtime-stale-temp');
    model.insertStored(message({ id: 'temp-old', status: 'sending', createdAt: '2026-01-01T00:00:00.000Z' }));
    model.insertStored(message({ id: 'temp-protected', status: 'sending', createdAt: '2026-01-01T00:00:00.000Z' }));
    model.insertStored(message({ id: 'temp-new', status: 'sending', createdAt: '2026-01-01T00:01:30.000Z' }));
    model.insertStored(message({ id: 'server-old', status: 'sending', createdAt: '2026-01-01T00:00:00.000Z' }));

    expect(resolveStaleTempRows(model, {
      maxAgeMs: 60_000,
      protectedIds: new Set(['temp-protected']),
      onStale: row => model.patch(row.id, { status: 'failed' })
    })).toBe(1);
    expect(model.get('temp-old')?.status).toBe('failed');
    expect(model.get('temp-protected')?.status).toBe('sending');
    expect(model.get('temp-new')?.status).toBe('sending');
    expect(model.get('server-old')?.status).toBe('sending');
  });

  it('coalesces concurrent calls and resolves interval-suppressed calls with undefined', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(10_000);
    const first = deferred<string>();
    const fn = jest.fn(() => first.promise);
    const run = createThrottledSingleFlight(fn, { minIntervalMs: 8_000 });

    const firstCall = run();
    const secondCall = run();
    expect(secondCall).toBe(firstCall);
    expect(fn).toHaveBeenCalledTimes(1);

    jest.spyOn(Date, 'now').mockReturnValue(10_100);
    first.resolve('synced');
    await expect(firstCall).resolves.toBe('synced');

    await expect(run()).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);

    jest.spyOn(Date, 'now').mockReturnValue(18_101);
    const third = run();
    await expect(third).resolves.toBe('synced');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not advance the throttle interval after failed executions', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(10_000);
    const fn = jest.fn().mockRejectedValueOnce(new Error('sync failed')).mockResolvedValueOnce('ok');
    const run = createThrottledSingleFlight(fn, { minIntervalMs: 8_000 });

    await expect(run()).resolves.toBeUndefined();
    await expect(run()).resolves.toBe('ok');

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('patches keyed shape arrays immutably with normalized append upserts and removals', () => {
    const patcher = createKeyedArrayPatcher(reactionShape, { key: 'id' });
    const original = [
      { id: 'a', kind: 'like', count: 1 },
      { id: 'b', kind: 'love', count: 2 }
    ];

    const upserted = patcher.upsert(original, { id: 'a', count: 3 });

    expect(upserted).toEqual([
      { id: 'b', kind: 'love', count: 2 },
      { id: 'a', kind: null, count: 3 }
    ]);
    expect(upserted).not.toBe(original);
    expect(original).toEqual([
      { id: 'a', kind: 'like', count: 1 },
      { id: 'b', kind: 'love', count: 2 }
    ]);
    expect(patcher.upsert(null, { id: 7, kind: 'wow' })).toEqual([{ id: '7', kind: 'wow', count: null }]);
    expect(patcher.remove(upserted, 'b')).toEqual([{ id: 'a', kind: null, count: 3 }]);
    expect(patcher.remove(undefined, 'missing')).toEqual([]);
  });

  it('patches nullable nested object fields with a shallow transform merge', () => {
    configureMemoryDb();
    type MediaRow = {
      id: string;
      media: {
        transcodeStatus: string;
        transcodeProgress: number | null;
        transcoded: boolean;
        coverUrl?: string | null;
      } | null;
    };
    const model = defineModel({
      id: 'runtime-nested-patcher',
      name: 'RuntimeNestedPatcherModel',
      fields: { media: f.raw<MediaRow['media']>().nullable() }
    });
    model.insertStored({ id: 'media-1', media: { transcodeStatus: 'PENDING', transcodeProgress: null, transcoded: false } });
    model.insertStored({ id: 'media-null', media: null });
    const updateTranscodeStatus = createNestedObjectPatcher(
      model,
      'media',
      (media: NonNullable<MediaRow['media']>, status: string, progress?: number | null) => {
        const normalizedStatus = status.trim().toUpperCase();
        return {
          transcodeStatus: normalizedStatus,
          transcoded: normalizedStatus === 'COMPLETED' || media.transcoded,
          ...(progress !== undefined ? { transcodeProgress: progress } : {})
        };
      }
    );

    expect(updateTranscodeStatus('media-1', ' completed ', 100)).toBe(true);
    expect(model.get('media-1')?.media).toEqual({
      transcodeStatus: 'COMPLETED',
      transcodeProgress: 100,
      transcoded: true
    });
    expect(updateTranscodeStatus('media-null', 'FAILED')).toBe(false);
  });

  it('patches id arrays immutably with dedupe, edge placement, and removals', () => {
    const patcher = createIdArrayPatcher();
    const original = ['a', 'b'];

    expect(patcher.upsert(original, 'a', 'append')).toEqual(['b', 'a']);
    expect(patcher.upsert(original, 'c', 'prepend')).toEqual(['c', 'a', 'b']);
    expect(patcher.upsert(null, 'a', 'append')).toEqual(['a']);
    expect(patcher.remove(original, 'b')).toEqual(['a']);
    expect(patcher.remove(undefined, 'b')).toEqual([]);
    expect(patcher.remove(original, 'missing')).not.toBe(original);
  });

  it('builds singleton statics for current reads, upsert, and clamped numeric patches', () => {
    configureMemoryDb();
    const defaults = {
      id: 'counters',
      unreadChatsCount: 0,
      unreadSecondaryChatsCount: 0
    };
    const model = defineModel({
      id: 'runtime-singleton',
      name: 'RuntimeSingletonModel',
      fields: {
        unreadChatsCount: f.num(),
        unreadSecondaryChatsCount: f.num()
      },
      statics: baseModel => singletonStatics(baseModel, 'counters', defaults)
    });
    const hook = renderHook(() => model.useCurrent());

    expect(model.current()).toBeUndefined();
    expect(hook.current).toEqual(defaults);

    act(() => {
      model.upsertCurrent({ id: 'ignored', unreadSecondaryChatsCount: 5 });
    });
    expect(model.current()).toEqual(expect.objectContaining({
      id: 'counters',
      unreadChatsCount: 0,
      unreadSecondaryChatsCount: 5
    }));

    act(() => {
      expect(model.patchClamped('unreadSecondaryChatsCount', -10)).toBe(true);
    });
    expect(hook.current.unreadSecondaryChatsCount).toBe(0);

    act(() => {
      hook.unmount();
    });
  });
});
