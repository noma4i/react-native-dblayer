import { configureDb, resetRuntime, type DbRetryPolicy } from '../../../index';
import { createFetchLedger } from '../../../core/fetch/fetchLedger';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

const configureRuntime = (): void => {
  configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
};

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(nextResolve => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

const createLedger = (options?: { now?: () => number; retry?: DbRetryPolicy; isOnline?: () => boolean; onStamp?: (key: string) => void; maxEntries?: number }) =>
  createFetchLedger({
    now: options?.now ?? (() => 100),
    retry: options?.retry ?? {},
    isOnline: options?.isOnline ?? (() => true),
    onStamp: options?.onStamp ?? (() => {}),
    maxEntries: options?.maxEntries ?? Number.MAX_SAFE_INTEGER
  });

describe('fetch ledger integrity', () => {
  beforeEach(() => {
    configureRuntime();
  });

  it('L1 stamps only outcomes applied to the current generation', async () => {
    const ledger = createLedger();

    await expect(ledger.run('applied', async () => ({ applied: true, count: 0, ids: [] }))).resolves.toBe('applied');
    await expect(ledger.run('skipped', async () => ({ applied: false }))).resolves.toBe('skipped');
    await expect(ledger.run('failed', async () => { throw new Error('failed'); })).resolves.toBe('failed');

    expect(ledger.read('applied')).toEqual({ lastAppliedAt: 100, lastCount: 0, cursor: null, pages: 1 });
    expect(ledger.read('skipped')).toBeUndefined();
    expect(ledger.read('failed')).toBeUndefined();
  });

  it('L2 invalidates and notes lost rows once per actual freshness change', async () => {
    const onStamp = jest.fn();
    const ledger = createLedger({ onStamp });

    await ledger.run('key', async () => ({ applied: true, count: 2, ids: ['Model\0first', 'Model\0second'] }));
    ledger.invalidate('key');
    ledger.invalidate('key');
    await ledger.run('key', async () => ({ applied: true, count: 3, ids: ['Model\0first', 'Model\0second'] }));
    ledger.noteRowsLost(['Model\0first', 'Model\0second']);
    ledger.noteRowsLost(['Model\0first', 'Model\0second']);

    expect(onStamp).toHaveBeenCalledTimes(4);
    expect(onStamp).toHaveBeenNthCalledWith(1, 'key');
    expect(onStamp).toHaveBeenNthCalledWith(2, 'key');
    expect(onStamp).toHaveBeenNthCalledWith(3, 'key');
    expect(onStamp).toHaveBeenNthCalledWith(4, 'key');
    expect(ledger.read('key')).toEqual({ lastAppliedAt: null, lastCount: null, cursor: null, pages: 0 });
  });

  it('L3 skips an outcome that resolves after the runtime generation changes', async () => {
    const ledger = createLedger();
    const deferred = createDeferred<{ applied: true; count: number; ids: readonly string[] }>();
    const pending = ledger.run('key', async () => await deferred.promise);

    resetRuntime();
    deferred.resolve({ applied: true, count: 1, ids: [] });

    await expect(pending).resolves.toBe('skipped');
    expect(ledger.read('key')).toBeUndefined();
  });

  it('L4 clears entries and flights on reset', async () => {
    const ledger = createLedger();
    await ledger.run('key', async () => ({ applied: true, count: 1, ids: [] }));
    const release = ledger.retain('key', async () => {});

    resetRuntime();

    expect(ledger.read('key')).toBeUndefined();
    expect(ledger.activeKeys()).toEqual([]);
    await expect(ledger.run('key', async () => ({ applied: true, count: 2, ids: [] }))).resolves.toBe('applied');
    expect(ledger.read('key')).toEqual({ lastAppliedAt: 100, lastCount: 2, cursor: null, pages: 1 });
    release();
  });

  it('L6 shares same-key flights while allowing different keys to execute independently', async () => {
    const ledger = createLedger();
    const deferred = createDeferred<{ applied: true; count: number; ids: readonly string[] }>();
    const execute = jest.fn(async () => await deferred.promise);

    const first = ledger.run('same', execute);
    const second = ledger.run('same', execute);
    const other = ledger.run('other', async () => ({ applied: true, count: 1, ids: [] }));
    deferred.resolve({ applied: true, count: 1, ids: [] });

    await expect(Promise.all([first, second, other])).resolves.toEqual(['applied', 'applied', 'applied']);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('L7 returns offline without invoking execute or changing freshness', async () => {
    const execute = jest.fn(async () => ({ applied: true as const, count: 1, ids: [] }));
    const ledger = createLedger({ isOnline: () => false });

    await expect(ledger.run('key', execute)).resolves.toBe('offline');

    expect(execute).not.toHaveBeenCalled();
    expect(ledger.read('key')).toBeUndefined();
  });

  it('L8 retries classified failures within budget and stamps a later success', async () => {
    let calls = 0;
    jest.useFakeTimers();
    try {
      const ledger = createLedger({ retry: { classify: () => 'network', budgets: { network: 2 }, backoff: { baseMs: 1, maxMs: 1 } } });
      const pending = ledger.run('key', async ({ attempt }) => {
        calls += 1;
        if (attempt < 3) throw new Error('offline');
        return { applied: true, count: 4, ids: [] };
      });

      await Promise.resolve();
      expect(calls).toBe(1);
      await jest.runAllTimersAsync();
      await expect(pending).resolves.toBe('applied');

      expect(calls).toBe(3);
      expect(ledger.read('key')).toEqual({ lastAppliedAt: 100, lastCount: 4, cursor: null, pages: 1 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('L8 returns failed after the retry budget is exhausted', async () => {
    jest.useFakeTimers();
    try {
      const ledger = createLedger({ retry: { classify: () => 'network', budgets: { network: 1 }, backoff: { baseMs: 1, maxMs: 1 } } });
      const execute = jest.fn(async () => { throw new Error('offline'); });
      const pending = ledger.run('key', execute);

      await jest.runAllTimersAsync();
      await expect(pending).resolves.toBe('failed');

      expect(execute).toHaveBeenCalledTimes(2);
      expect(ledger.read('key')).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('L10 reports freshness only inside the configured window', async () => {
    let now = 100;
    const ledger = createLedger({ now: () => now });

    expect(ledger.isFresh('key', 1)).toBe(false);
    await ledger.run('key', async () => ({ applied: true, count: 1, ids: [] }));
    now = 110;
    expect(ledger.isFresh('key', 10)).toBe(true);
    now = 111;
    expect(ledger.isFresh('key', 10)).toBe(false);
  });

  it('L5 evicts the oldest unretained entry and keeps retained entries beyond the limit', async () => {
    let now = 1;
    const ledger = createLedger({ now: () => now, maxEntries: 2 });
    await ledger.run('oldest', async () => ({ applied: true, count: 1, ids: [] }));
    now = 2;
    await ledger.run('retained', async () => ({ applied: true, count: 1, ids: [] }));
    const release = ledger.retain('retained', async () => {});
    now = 3;
    await ledger.run('newest', async () => ({ applied: true, count: 1, ids: [] }));

    expect(ledger.read('oldest')).toBeUndefined();
    expect(ledger.read('retained')).toBeDefined();
    expect(ledger.read('newest')).toBeDefined();

    const protectedLedger = createLedger({ maxEntries: 1 });
    await protectedLedger.run('retained', async () => ({ applied: true, count: 1, ids: [] }));
    const releaseProtected = protectedLedger.retain('retained', async () => {});
    const releaseOverflow = protectedLedger.retain('overflow', async () => {});
    await protectedLedger.run('overflow', async () => ({ applied: true, count: 1, ids: [] }));

    expect(protectedLedger.read('retained')).toBeDefined();
    expect(protectedLedger.read('overflow')).toBeDefined();
    release();
    releaseProtected();
    releaseOverflow();
  });

  it('L9 resumes retained keys in settled chunks', async () => {
    const ledger = createLedger();
    const first = createDeferred<void>();
    const second = createDeferred<void>();
    const refetchFirst = jest.fn(async () => await first.promise);
    const refetchSecond = jest.fn(async () => await second.promise);
    const refetchThird = jest.fn(async () => {});
    const releaseFirst = ledger.retain('first', refetchFirst);
    const releaseSecond = ledger.retain('second', refetchSecond);
    const releaseThird = ledger.retain('third', refetchThird);
    const pending = ledger.resume(2);

    await Promise.resolve();
    expect(refetchFirst).toHaveBeenCalledTimes(1);
    expect(refetchSecond).toHaveBeenCalledTimes(1);
    expect(refetchThird).not.toHaveBeenCalled();
    first.resolve();
    second.resolve();

    await expect(pending).resolves.toBeUndefined();
    expect(refetchThird).toHaveBeenCalledTimes(1);
    releaseFirst();
    releaseSecond();
    releaseThird();
  });

  it('L11 passes the applied cursor to the next run and grows pages', async () => {
    const ledger = createLedger();

    await ledger.run('key', async context => {
      expect(context.cursor).toBeNull();
      return { applied: true, count: 1, ids: [], cursor: 'second-page' };
    });
    await ledger.run('key', async context => {
      expect(context.cursor).toBe('second-page');
      return { applied: true, count: 2, ids: [], cursor: 'third-page' };
    });

    expect(ledger.read('key')).toEqual({ lastAppliedAt: 100, lastCount: 2, cursor: 'third-page', pages: 2 });
  });

  it('L12 invalidation and row loss reset the page chain', async () => {
    const ledger = createLedger();
    await ledger.run('key', async () => ({ applied: true, count: 1, ids: ['Model\0row'], cursor: 'next-page' }));

    ledger.invalidate('key');
    expect(ledger.read('key')).toEqual({ lastAppliedAt: null, lastCount: null, cursor: null, pages: 0 });
    await ledger.run('key', async context => {
      expect(context.cursor).toBeNull();
      return { applied: true, count: 1, ids: ['Model\0row'], cursor: 'next-page' };
    });
    ledger.noteRowsLost(['Model\0row']);

    expect(ledger.read('key')).toEqual({ lastAppliedAt: null, lastCount: null, cursor: null, pages: 0 });
  });

  it('L13 removes a key from activeKeys after every reader releases it', () => {
    const ledger = createLedger();
    const releaseFirst = ledger.retain('key', async () => {});
    const releaseSecond = ledger.retain('key', async () => {});

    expect(ledger.activeKeys()).toEqual(['key']);
    releaseFirst();
    expect(ledger.activeKeys()).toEqual(['key']);
    releaseSecond();
    expect(ledger.activeKeys()).toEqual([]);
  });

  it('L14 continues resume after a refetch rejection', async () => {
    const ledger = createLedger();
    const rejected = jest.fn(async () => { throw new Error('failed'); });
    const fulfilled = jest.fn(async () => {});
    const releaseRejected = ledger.retain('rejected', rejected);
    const releaseFulfilled = ledger.retain('fulfilled', fulfilled);

    await expect(ledger.resume(2)).resolves.toBeUndefined();

    expect(rejected).toHaveBeenCalledTimes(1);
    expect(fulfilled).toHaveBeenCalledTimes(1);
    releaseRejected();
    releaseFulfilled();
  });

  it('L15 keeps freshness and does not stamp when a committed identity partially survives', async () => {
    const onStamp = jest.fn();
    const ledger = createLedger({ onStamp });
    await ledger.run('key', async () => ({ applied: true, count: 2, ids: ['Model\0first', 'Model\0second'] }));

    ledger.noteRowsLost(['Model\0first']);

    expect(ledger.isFresh('key', Infinity)).toBe(true);
    expect(onStamp).toHaveBeenCalledTimes(1);
  });

  it('L16 drops freshness and stamps once when every committed identity is lost', async () => {
    const onStamp = jest.fn();
    const ledger = createLedger({ onStamp });
    await ledger.run('key', async () => ({ applied: true, count: 2, ids: ['Model\0first', 'Model\0second'] }));

    ledger.noteRowsLost(['Model\0first', 'Model\0second']);
    ledger.noteRowsLost(['Model\0first', 'Model\0second']);

    expect(ledger.isFresh('key', Infinity)).toBe(false);
    expect(onStamp).toHaveBeenCalledTimes(2);
  });

  it('L17 replaces committed identities on a new application so old identities no longer affect freshness', async () => {
    const onStamp = jest.fn();
    const ledger = createLedger({ onStamp });
    await ledger.run('key', async () => ({ applied: true, count: 1, ids: ['Model\0old'] }));
    await ledger.run('key', async () => ({ applied: true, count: 1, ids: ['Model\0new'] }));

    ledger.noteRowsLost(['Model\0new']);
    expect(ledger.isFresh('key', Infinity)).toBe(false);
    await ledger.run('key', async () => ({ applied: true, count: 1, ids: ['Model\0new'] }));
    ledger.noteRowsLost(['Model\0old']);

    expect(ledger.isFresh('key', Infinity)).toBe(true);
    expect(onStamp).toHaveBeenCalledTimes(3);
  });
});
