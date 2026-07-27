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

const createLedger = (options?: { now?: () => number; retry?: DbRetryPolicy; isOnline?: () => boolean; onStamp?: (key: string) => void }) =>
  createFetchLedger({
    now: options?.now ?? (() => 100),
    retry: options?.retry ?? {},
    isOnline: options?.isOnline ?? (() => true),
    onStamp: options?.onStamp ?? (() => {})
  });

describe('fetch ledger integrity', () => {
  beforeEach(() => {
    configureRuntime();
  });

  it('L1 stamps only outcomes applied to the current generation', async () => {
    const ledger = createLedger();

    await expect(ledger.run('applied', async () => ({ applied: true, count: 0 }))).resolves.toBe('applied');
    await expect(ledger.run('skipped', async () => ({ applied: false }))).resolves.toBe('skipped');
    await expect(ledger.run('failed', async () => { throw new Error('failed'); })).resolves.toBe('failed');

    expect(ledger.read('applied')).toEqual({ lastAppliedAt: 100, lastCount: 0 });
    expect(ledger.read('skipped')).toBeUndefined();
    expect(ledger.read('failed')).toBeUndefined();
  });

  it('L2 invalidates and notes lost rows once per actual freshness change', async () => {
    const onStamp = jest.fn();
    const ledger = createLedger({ onStamp });

    await ledger.run('key', async () => ({ applied: true, count: 2 }));
    ledger.invalidate('key');
    ledger.invalidate('key');
    await ledger.run('key', async () => ({ applied: true, count: 3 }));
    ledger.noteRowsLost('key');
    ledger.noteRowsLost('key');

    expect(onStamp).toHaveBeenCalledTimes(4);
    expect(onStamp).toHaveBeenNthCalledWith(1, 'key');
    expect(onStamp).toHaveBeenNthCalledWith(2, 'key');
    expect(onStamp).toHaveBeenNthCalledWith(3, 'key');
    expect(onStamp).toHaveBeenNthCalledWith(4, 'key');
    expect(ledger.read('key')).toBeUndefined();
  });

  it('L3 skips an outcome that resolves after the runtime generation changes', async () => {
    const ledger = createLedger();
    const deferred = createDeferred<{ applied: true; count: number }>();
    const pending = ledger.run('key', async () => await deferred.promise);

    resetRuntime();
    deferred.resolve({ applied: true, count: 1 });

    await expect(pending).resolves.toBe('skipped');
    expect(ledger.read('key')).toBeUndefined();
  });

  it('L4 clears entries and flights on reset', async () => {
    const ledger = createLedger();
    await ledger.run('key', async () => ({ applied: true, count: 1 }));

    resetRuntime();

    expect(ledger.read('key')).toBeUndefined();
    await expect(ledger.run('key', async () => ({ applied: true, count: 2 }))).resolves.toBe('applied');
    expect(ledger.read('key')).toEqual({ lastAppliedAt: 100, lastCount: 2 });
  });

  it('L6 shares same-key flights while allowing different keys to execute independently', async () => {
    const ledger = createLedger();
    const deferred = createDeferred<{ applied: true; count: number }>();
    const execute = jest.fn(async () => await deferred.promise);

    const first = ledger.run('same', execute);
    const second = ledger.run('same', execute);
    const other = ledger.run('other', async () => ({ applied: true, count: 1 }));
    deferred.resolve({ applied: true, count: 1 });

    await expect(Promise.all([first, second, other])).resolves.toEqual(['applied', 'applied', 'applied']);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('L7 returns offline without invoking execute or changing freshness', async () => {
    const execute = jest.fn(async () => ({ applied: true as const, count: 1 }));
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
        return { applied: true, count: 4 };
      });

      await Promise.resolve();
      expect(calls).toBe(1);
      await jest.runAllTimersAsync();
      await expect(pending).resolves.toBe('applied');

      expect(calls).toBe(3);
      expect(ledger.read('key')).toEqual({ lastAppliedAt: 100, lastCount: 4 });
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
    await ledger.run('key', async () => ({ applied: true, count: 1 }));
    now = 110;
    expect(ledger.isFresh('key', 10)).toBe(true);
    now = 111;
    expect(ledger.isFresh('key', 10)).toBe(false);
  });
});
