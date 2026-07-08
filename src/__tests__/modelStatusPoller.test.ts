import { configureDb, createModelStatusPoller, devClearAllDataAndState } from '../index';
import { mockTransport } from './helpers/testRuntime';

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

const flush = () => Promise.resolve();

describe('model status poller', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    devClearAllDataAndState();
    configureDb({ transport: mockTransport({}), modelDefaults: {} });
  });

  it('starts on first attach, ticks on intervals, and stops on last detach', async () => {
    const fetch = jest.fn(async () => ({ terminal: false }));
    const apply = jest.fn();
    const poller = createModelStatusPoller<{ terminal: boolean }>({
      fetch,
      apply,
      isTerminal: result => result.terminal,
      intervalMs: 1000,
      maxAttempts: 5
    });

    const detachA = poller.attach('item-1');
    const detachB = poller.attach('item-1');
    await flush();

    expect(poller.isPolling('item-1')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(2);

    detachA();
    expect(poller.isPolling('item-1')).toBe(true);

    detachB();
    expect(poller.isPolling('item-1')).toBe(false);

    await jest.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops when a terminal result is applied', async () => {
    const fetch = jest.fn(async () => ({ terminal: true }));
    const apply = jest.fn();
    const poller = createModelStatusPoller<{ terminal: boolean }>({
      fetch,
      apply,
      isTerminal: result => result.terminal,
      intervalMs: 1000,
      maxAttempts: 5
    });

    poller.attach('item-terminal');
    await flush();

    expect(apply).toHaveBeenCalledWith('item-terminal', { terminal: true });
    expect(poller.isPolling('item-terminal')).toBe(false);
  });

  it('stops when the attempt budget is exhausted', async () => {
    const fetch = jest.fn(async () => ({ terminal: false }));
    const poller = createModelStatusPoller<{ terminal: boolean }>({
      fetch,
      apply: jest.fn(),
      isTerminal: result => result.terminal,
      intervalMs: 1000,
      maxAttempts: 2
    });

    poller.attach('item-budget');
    await flush();
    await jest.advanceTimersByTimeAsync(1000);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(poller.isPolling('item-budget')).toBe(false);
  });

  it('refreshes immediately and resetBudget restarts a stopped budget', async () => {
    const fetch = jest.fn(async () => ({ terminal: false }));
    const poller = createModelStatusPoller<{ terminal: boolean }>({
      fetch,
      apply: jest.fn(),
      isTerminal: result => result.terminal,
      intervalMs: 1000,
      maxAttempts: 1
    });

    poller.attach('item-refresh');
    await flush();
    expect(poller.isPolling('item-refresh')).toBe(false);

    await poller.refresh('item-refresh');
    expect(fetch).toHaveBeenCalledTimes(1);

    await poller.refresh('item-refresh', { resetBudget: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(poller.isPolling('item-refresh')).toBe(false);
  });

  it('dedupes overlapping fetches for the same id', async () => {
    const pending = deferred<{ terminal: boolean }>();
    const fetch = jest.fn(() => pending.promise);
    const poller = createModelStatusPoller({
      fetch,
      apply: jest.fn(),
      isTerminal: result => result.terminal,
      intervalMs: 1000,
      maxAttempts: 5
    });

    poller.attach('item-dedupe');
    await poller.refresh('item-dedupe');
    await jest.advanceTimersByTimeAsync(1000);

    expect(fetch).toHaveBeenCalledTimes(1);

    pending.resolve({ terminal: false });
    await flush();
    await jest.advanceTimersByTimeAsync(1000);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('logs errors, consumes attempts, and continues until budget exhaustion', async () => {
    const logger = { debug: jest.fn(), error: jest.fn() };
    const fetch = jest.fn()
      .mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValue({ terminal: false });
    configureDb({
      transport: mockTransport({}),
      logger
    });
    const poller = createModelStatusPoller<{ terminal: boolean }>({
      fetch,
      apply: jest.fn(),
      isTerminal: result => result.terminal,
      intervalMs: 1000,
      maxAttempts: 2
    });

    poller.attach('item-error');
    await flush();

    expect(logger.error).toHaveBeenCalledWith('ModelStatusPoller', 'fetch failed', expect.objectContaining({ id: 'item-error', attempts: 1 }));
    expect(poller.isPolling('item-error')).toBe(true);

    await jest.advanceTimersByTimeAsync(1000);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(poller.isPolling('item-error')).toBe(false);
  });
});
