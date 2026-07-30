import { configureDb, createModelStatusPoller, resetRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport, settle } from '../helpers/harness';

type Result = { status: 'processing' | 'ready' };

const setup = () => {
  const logger = { debug: jest.fn(), error: jest.fn() };
  configureDb({ storage: createMemoryPlane(), transport: createMockTransport(), logger });
  return logger;
};

describe('model status poller edge contracts', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('isolates subscriber and stop-callback failures', async () => {
    jest.useFakeTimers();
    const logger = setup();
    const poller = createModelStatusPoller<Result>({
      fetch: async () => ({ status: 'ready' }),
      apply: () => {},
      classify: result => (result.status === 'ready' ? 'ready' : null),
      onSessionStop: () => {
        throw new Error('stop failed');
      },
      intervalMs: 10,
      maxAttempts: 2
    });
    poller.subscribe('row-1', () => {
      throw new Error('subscriber failed');
    });

    const detach = poller.attach('row-1');
    await settle(4);
    detach();

    expect(logger.error).toHaveBeenCalledWith('ModelStatusPoller', 'phase subscriber failed', expect.objectContaining({ id: 'row-1' }));
    expect(logger.error).toHaveBeenCalledWith(
      'ModelStatusPoller',
      'session stop callback failed',
      expect.objectContaining({ id: 'row-1', reason: 'terminal-payload' })
    );
  });

  it('reports fetch errors and detaches a zero-ref refresh session', async () => {
    const logger = setup();
    const failing = createModelStatusPoller<Result>({
      fetch: async () => {
        throw new Error('fetch failed');
      },
      apply: () => {},
      intervalMs: 1000,
      maxAttempts: 2
    });

    await failing.refresh('failed-row');

    expect(logger.error).toHaveBeenCalledWith('ModelStatusPoller', 'fetch failed', expect.objectContaining({ id: 'failed-row', attempts: 1 }));
    expect(failing.getPhase('failed-row')).toEqual({ phase: 'idle', reason: 'stopped', attempts: 1 });
  });

  it('stalls before fetching when the budget is zero', async () => {
    setup();
    const fetch = jest.fn(async () => ({ status: 'processing' as const }));
    const poller = createModelStatusPoller<Result>({ fetch, apply: () => {}, intervalMs: 1000, maxAttempts: 0 });

    await poller.refresh('row-1');

    expect(fetch).not.toHaveBeenCalled();
    expect(poller.getPhase('row-1')).toEqual({ phase: 'stalled', reason: 'budget-exhausted', attempts: 0 });
  });

  it('does not fetch again from a terminal phase without an explicit budget reset', async () => {
    setup();
    const fetch = jest.fn(async () => ({ status: 'ready' as const }));
    const poller = createModelStatusPoller<Result>({
      fetch,
      apply: () => {},
      classify: result => (result.status === 'ready' ? 'ready' : null),
      intervalMs: 1000,
      maxAttempts: 2
    });

    await poller.refresh('row-1');
    await poller.refresh('row-1');

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(poller.getPhase('row-1').phase).toBe('ready');
  });

  it('does not emit a duplicate polling snapshot during overlapping budget resets', async () => {
    setup();
    let resolve!: (result: Result) => void;
    const poller = createModelStatusPoller<Result>({
      fetch: () => new Promise<Result>(nextResolve => (resolve = nextResolve)),
      apply: () => {},
      intervalMs: 1000,
      maxAttempts: 2
    });
    const listener = jest.fn();
    poller.subscribe('row-1', listener);
    const first = poller.refresh('row-1', { resetBudget: true });
    const second = poller.refresh('row-1', { resetBudget: true });
    const calls = listener.mock.calls.length;
    const third = poller.refresh('row-1', { resetBudget: true });

    expect(listener).toHaveBeenCalledTimes(calls);
    resolve({ status: 'processing' });
    await Promise.all([first, second, third]);
  });

  it('fences a completion whose apply callback resets the runtime', async () => {
    setup();
    const classify = jest.fn(() => null);
    const poller = createModelStatusPoller<Result>({
      fetch: async () => ({ status: 'processing' }),
      apply: () => resetRuntime(),
      classify,
      intervalMs: 1000,
      maxAttempts: 2
    });

    await poller.refresh('row-1');

    expect(poller.getPhase('row-1')).toEqual({ phase: 'idle', attempts: 0 });
    expect(classify).not.toHaveBeenCalled();
  });

  it('keeps shared attachment state and makes duplicate cleanup inert', async () => {
    jest.useFakeTimers();
    setup();
    const poller = createModelStatusPoller<Result>({
      fetch: async () => ({ status: 'processing' }),
      apply: () => {},
      intervalMs: 1000,
      maxAttempts: 3
    });
    const unsubscribe = poller.subscribe('row-1', () => {});
    const detachFirst = poller.attach('row-1');
    const detachSecond = poller.attach('row-1');
    await settle(4);

    expect(poller.isPolling('row-1')).toBe(true);
    detachFirst();
    expect(poller.isPolling('row-1')).toBe(true);
    detachFirst();
    detachSecond();
    unsubscribe();
    unsubscribe();

    expect(poller.isPolling('row-1')).toBe(false);
  });
});
