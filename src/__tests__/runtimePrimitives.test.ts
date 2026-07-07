import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  configureDb,
  createNestedObjectPatcher,
  createThrottledSingleFlight,
  defineModel,
  devClearAllDataAndState,
  f,
  pruneOrphanedRows,
  reconcileOptimisticRows,
  resolveStaleTempRows,
  singletonStatics,
  trimRowsPerScope
} from '../index';
import { installMemoryStorage, mockTransport } from './helpers/testRuntime';

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

type MessageRow = {
  id: string;
  chatId: string;
  userId: string;
  body: string;
  createdAt: string;
  status: string | null;
  sequenceNumber: number | null;
};

const createMessageModel = (id = 'runtime-messages') =>
  defineModel<MessageRow, MessageRow>({
    id,
    name: `RuntimeMessageModel:${id}`,
    normalize: input => ({
      id: input.id,
      chatId: input.chatId,
      userId: input.userId,
      body: input.body,
      createdAt: input.createdAt,
      status: input.status ?? null,
      sequenceNumber: input.sequenceNumber ?? null
    }),
    merge: {},
    replace: {}
  });

const message = (input: Partial<MessageRow> & Pick<MessageRow, 'id' | 'createdAt'>): MessageRow => ({
  chatId: 'chat-1',
  userId: 'user-1',
  body: 'hello',
  status: null,
  sequenceNumber: null,
  ...input
});

describe('runtime primitives', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    devClearAllDataAndState();
    configureDb({ transport: mockTransport({}), modelDefaults: {} });
  });

  it('reconciles optimistic rows by scoped candidates, content match, window, best delta, and existing server ids', () => {
    installMemoryStorage();
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
    installMemoryStorage();
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

  it('prunes orphaned rows with a batched destroyMany call', () => {
    installMemoryStorage();
    const model = defineModel<{ id: string; momentId: string }, { id: string; momentId: string }>({
      id: 'runtime-orphans',
      name: 'RuntimeOrphanModel',
      normalize: input => input,
      merge: {}
    });
    model.insertStored({ id: 'join-1', momentId: 'moment-1' });
    model.insertStored({ id: 'join-2', momentId: 'moment-missing' });
    model.insertStored({ id: 'join-3', momentId: 'moment-missing-2' });
    const destroyMany = jest.spyOn(model, 'destroyMany');

    expect(pruneOrphanedRows(model, 'momentId', new Set(['moment-1']))).toBe(2);

    expect(destroyMany).toHaveBeenCalledWith(['join-2', 'join-3']);
    expect(model.getAll().map(row => row.id)).toEqual(['join-1']);
  });

  it('trims newest rows per scope while excluding protected rows from the limit', () => {
    installMemoryStorage();
    const model = createMessageModel('runtime-trim');
    model.insertStored(message({ id: 'old-protected', createdAt: '2026-01-01T00:00:00.000Z', sequenceNumber: 1 }));
    model.insertStored(message({ id: 'new-1', createdAt: '2026-01-01T00:00:03.000Z', sequenceNumber: 4 }));
    model.insertStored(message({ id: 'new-2', createdAt: '2026-01-01T00:00:02.000Z', sequenceNumber: 3 }));
    model.insertStored(message({ id: 'old-delete', createdAt: '2026-01-01T00:00:01.000Z', sequenceNumber: 2 }));
    const destroyMany = jest.spyOn(model, 'destroyMany');

    const deleted = trimRowsPerScope(model, 'chatId', 2, (left, right) => (right.sequenceNumber ?? 0) - (left.sequenceNumber ?? 0), new Set(['old-protected']));

    expect(deleted).toBe(1);
    expect(destroyMany).toHaveBeenCalledWith(['old-delete']);
    expect(model.getAll().map(row => row.id).sort()).toEqual(['new-1', 'new-2', 'old-protected']);
  });

  it('resolves stale temp rows by age while skipping protected and non-temp rows', () => {
    installMemoryStorage();
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-01-01T00:02:00.000Z').getTime());
    const model = createMessageModel('runtime-stale-temp');
    model.insertStored(message({ id: 'temp-old', status: 'sending', createdAt: '2026-01-01T00:00:00.000Z' }));
    model.insertStored(message({ id: 'temp-protected', status: 'sending', createdAt: '2026-01-01T00:00:00.000Z' }));
    model.insertStored(message({ id: 'temp-new', status: 'sending', createdAt: '2026-01-01T00:01:30.000Z' }));
    model.insertStored(message({ id: 'server-old', status: 'sending', createdAt: '2026-01-01T00:00:00.000Z' }));

    const resolved = resolveStaleTempRows(model, {
      maxAgeMs: 60_000,
      protectedIds: new Set(['temp-protected']),
      onStale: row => {
        model.patch(row.id, { status: 'failed' });
      }
    });

    expect(resolved).toBe(1);
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

  it('patches nullable nested object fields with a shallow transform merge', () => {
    installMemoryStorage();
    type MediaRow = {
      id: string;
      media: {
        transcodeStatus: string;
        transcodeProgress: number | null;
        transcoded: boolean;
        coverUrl?: string | null;
      } | null;
    };
    const model = defineModel<MediaRow, MediaRow>({
      id: 'runtime-nested-patcher',
      name: 'RuntimeNestedPatcherModel',
      normalize: input => input,
      merge: {}
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

  it('builds singleton statics for current reads, upsert, and clamped numeric patches', () => {
    installMemoryStorage();
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
    let renderedCurrent: typeof defaults | undefined;
    let renderer!: TestRenderer.ReactTestRenderer;
    const Harness = () => {
      renderedCurrent = model.useCurrent();
      return null;
    };

    act(() => {
      renderer = TestRenderer.create(React.createElement(Harness));
    });

    expect(model.current()).toBeUndefined();
    expect(renderedCurrent).toEqual(defaults);

    model.upsertCurrent({ id: 'ignored', unreadSecondaryChatsCount: 5 });
    expect(model.current()).toEqual(expect.objectContaining({
      id: 'counters',
      unreadChatsCount: 0,
      unreadSecondaryChatsCount: 5
    }));

    expect(model.patchClamped('unreadSecondaryChatsCount', -10)).toBe(true);
    expect(model.current()?.unreadSecondaryChatsCount).toBe(0);

    act(() => {
      renderer.unmount();
    });
  });
});
