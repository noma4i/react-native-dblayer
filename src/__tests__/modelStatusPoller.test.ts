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
    const onSessionStop = jest.fn();
    const poller = createModelStatusPoller<{ terminal: boolean }>({
      fetch,
      apply,
      isTerminal: result => result.terminal,
      onSessionStop,
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
    expect(poller.isSessionTerminal('item-1')).toBe(false);
    expect(onSessionStop).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops when a terminal result is applied', async () => {
    const fetch = jest.fn(async () => ({ terminal: true }));
    const apply = jest.fn();
    const onSessionStop = jest.fn();
    const poller = createModelStatusPoller<{ terminal: boolean }>({
      fetch,
      apply,
      isTerminal: result => result.terminal,
      onSessionStop,
      intervalMs: 1000,
      maxAttempts: 5
    });

    poller.attach('item-terminal');
    await flush();

    expect(apply).toHaveBeenCalledWith('item-terminal', { terminal: true });
    expect(poller.isPolling('item-terminal')).toBe(false);
    expect(poller.isSessionTerminal('item-terminal')).toBe(true);
    expect(onSessionStop).toHaveBeenCalledTimes(1);
    expect(onSessionStop).toHaveBeenCalledWith('item-terminal', 'terminal');

    await poller.refresh('item-terminal');
    expect(onSessionStop).toHaveBeenCalledTimes(1);
  });

  it('subscribes to terminal snapshot changes without attaching polling consumers', async () => {
    const fetch = jest.fn(async () => ({ terminal: true }));
    const poller = createModelStatusPoller<{ terminal: boolean }>({
      fetch,
      apply: jest.fn(),
      isTerminal: result => result.terminal,
      intervalMs: 1000,
      maxAttempts: 5
    });
    const first = jest.fn();
    const second = jest.fn();
    const other = jest.fn();
    const unsubscribeFirst = poller.subscribe('item-subscribed', first);
    poller.subscribe('item-subscribed', second);
    poller.subscribe('item-other', other);

    expect(fetch).not.toHaveBeenCalled();
    expect(poller.isPolling('item-subscribed')).toBe(false);

    const detach = poller.attach('item-subscribed');
    await flush();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();

    unsubscribeFirst();
    detach();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(poller.isSessionTerminal('item-subscribed')).toBe(false);
  });

  it('notifies when resetBudget clears a terminal snapshot', async () => {
    const fetch = jest.fn().mockResolvedValueOnce({ terminal: true }).mockResolvedValueOnce({ terminal: false });
    const poller = createModelStatusPoller<{ terminal: boolean }>({
      fetch,
      apply: jest.fn(),
      isTerminal: result => result.terminal,
      intervalMs: 1000,
      maxAttempts: 5
    });
    const subscriber = jest.fn();
    poller.subscribe('item-reset', subscriber);
    poller.attach('item-reset');
    await flush();

    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(poller.isSessionTerminal('item-reset')).toBe(true);

    await poller.refresh('item-reset', { resetBudget: true });

    expect(subscriber).toHaveBeenCalledTimes(2);
    expect(poller.isSessionTerminal('item-reset')).toBe(false);
  });

  it('contains throwing terminal subscribers', async () => {
    const logger = { debug: jest.fn(), error: jest.fn() };
    configureDb({ transport: mockTransport({}), logger });
    const poller = createModelStatusPoller<{ terminal: boolean }>({
      fetch: jest.fn(async () => ({ terminal: true })),
      apply: jest.fn(),
      isTerminal: result => result.terminal,
      intervalMs: 1000,
      maxAttempts: 5
    });
    poller.subscribe('item-subscriber-error', () => {
      throw new Error('subscriber failed');
    });

    poller.attach('item-subscriber-error');
    await flush();

    expect(poller.isSessionTerminal('item-subscriber-error')).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      'ModelStatusPoller',
      'terminal subscriber failed',
      expect.objectContaining({ id: 'item-subscriber-error', error: expect.any(Error) })
    );
  });

  it('stops when the attempt budget is exhausted', async () => {
    const fetch = jest.fn(async () => ({ terminal: false }));
    const onSessionStop = jest.fn();
    const poller = createModelStatusPoller<{ terminal: boolean }>({
      fetch,
      apply: jest.fn(),
      isTerminal: result => result.terminal,
      onSessionStop,
      intervalMs: 1000,
      maxAttempts: 2
    });

    poller.attach('item-budget');
    await flush();
    await jest.advanceTimersByTimeAsync(1000);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(poller.isPolling('item-budget')).toBe(false);
    expect(poller.isSessionTerminal('item-budget')).toBe(true);
    expect(onSessionStop).toHaveBeenCalledTimes(1);
    expect(onSessionStop).toHaveBeenCalledWith('item-budget', 'budget');
  });

  it('stops before fetching when the attempt budget is already exhausted', async () => {
    const fetch = jest.fn(async () => ({ terminal: false }));
    const onSessionStop = jest.fn();
    const poller = createModelStatusPoller<{ terminal: boolean }>({
      fetch,
      apply: jest.fn(),
      isTerminal: result => result.terminal,
      onSessionStop,
      intervalMs: 1000,
      maxAttempts: 0
    });

    poller.attach('item-pre-budget');
    await flush();

    expect(fetch).not.toHaveBeenCalled();
    expect(poller.isPolling('item-pre-budget')).toBe(false);
    expect(poller.isSessionTerminal('item-pre-budget')).toBe(true);
    expect(onSessionStop).toHaveBeenCalledTimes(1);
    expect(onSessionStop).toHaveBeenCalledWith('item-pre-budget', 'budget');
  });

  it('does not emit session stop after last detach while a fetch is in flight', async () => {
    const pending = deferred<{ terminal: boolean }>();
    const fetch = jest.fn(() => pending.promise);
    const onSessionStop = jest.fn();
    const poller = createModelStatusPoller<{ terminal: boolean }>({
      fetch,
      apply: jest.fn(),
      isTerminal: result => result.terminal,
      onSessionStop,
      intervalMs: 1000,
      maxAttempts: 5
    });

    const detach = poller.attach('item-detached-in-flight');
    await flush();
    detach();

    pending.resolve({ terminal: true });
    await flush();

    expect(poller.isPolling('item-detached-in-flight')).toBe(false);
    expect(poller.isSessionTerminal('item-detached-in-flight')).toBe(false);
    expect(onSessionStop).not.toHaveBeenCalled();
  });

  it('refreshes immediately and resetBudget restarts a stopped budget', async () => {
    const pending = deferred<{ terminal: boolean }>();
    const fetch = jest.fn()
      .mockResolvedValueOnce({ terminal: false })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ terminal: false });
    const onSessionStop = jest.fn();
    const poller = createModelStatusPoller<{ terminal: boolean }>({
      fetch,
      apply: jest.fn(),
      isTerminal: result => result.terminal,
      onSessionStop,
      intervalMs: 1000,
      maxAttempts: 1
    });

    poller.attach('item-refresh');
    await flush();
    expect(poller.isPolling('item-refresh')).toBe(false);
    expect(poller.isSessionTerminal('item-refresh')).toBe(true);
    expect(onSessionStop).toHaveBeenCalledTimes(1);
    expect(onSessionStop).toHaveBeenLastCalledWith('item-refresh', 'budget');

    await poller.refresh('item-refresh');
    expect(fetch).toHaveBeenCalledTimes(1);

    const resetRefresh = poller.refresh('item-refresh', { resetBudget: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(poller.isSessionTerminal('item-refresh')).toBe(false);

    pending.resolve({ terminal: false });
    await resetRefresh;

    expect(poller.isPolling('item-refresh')).toBe(false);
    expect(poller.isSessionTerminal('item-refresh')).toBe(true);
    expect(onSessionStop).toHaveBeenCalledTimes(2);
    expect(onSessionStop).toHaveBeenLastCalledWith('item-refresh', 'budget');
  });

  it('contains throwing session stop callbacks', async () => {
    const logger = { debug: jest.fn(), error: jest.fn() };
    configureDb({
      transport: mockTransport({}),
      logger
    });
    const fetch = jest.fn(async () => ({ terminal: true }));
    const poller = createModelStatusPoller<{ terminal: boolean }>({
      fetch,
      apply: jest.fn(),
      isTerminal: result => result.terminal,
      onSessionStop: () => {
        throw new Error('callback failed');
      },
      intervalMs: 1000,
      maxAttempts: 5
    });

    poller.attach('item-callback-error');
    await flush();

    expect(poller.isSessionTerminal('item-callback-error')).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      'ModelStatusPoller',
      'session stop callback failed',
      expect.objectContaining({ id: 'item-callback-error', reason: 'terminal', error: expect.any(Error) })
    );
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
