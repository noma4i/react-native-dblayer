import {
  configureDb,
  createKeyedBatchBuffer,
  createThrottledSingleFlight
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
});
