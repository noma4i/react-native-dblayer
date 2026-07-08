import { configureDb, createDbSubscriptionRuntime, setDbLogger } from '../index';
import type { DbGraphQLDocument, DbTransport } from '../types';
import { mockTransport } from './helpers/testRuntime';

type TestPayload = {
  id: string;
  chatId?: string;
  value?: number;
};

type SubscribeRecord = {
  options: { query: DbGraphQLDocument; variables?: Record<string, unknown> };
  handlers: { next: (data: unknown) => void; error: (error: unknown) => void };
  unsubscribe: jest.Mock;
};

const noop = (): void => {};
const query = {} as DbGraphQLDocument;

const createTransport = () => {
  const records: SubscribeRecord[] = [];
  const transport: DbTransport = {
    query: async <TData>() => ({ data: {} as TData }),
    mutation: async <TData>() => ({ data: {} as TData }),
    subscribe: jest.fn((options, handlers) => {
      const unsubscribe = jest.fn();
      records.push({ options, handlers, unsubscribe });
      return unsubscribe;
    })
  };

  return { records, transport };
};

describe('subscription runtime', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
  });

  afterEach(() => {
    jest.useRealTimers();
    setDbLogger({ debug: noop, error: noop });
    configureDb({ transport: mockTransport({}), modelDefaults: {} });
  });

  it('activates all entries once and deactivates by unsubscribing entries', () => {
    const { records, transport } = createTransport();
    configureDb({ transport });
    const first = jest.fn();
    const second = jest.fn();
    const runtime = createDbSubscriptionRuntime([
      { key: 'first', query, vars: { static: true }, onData: first },
      { key: 'second', query, onData: second }
    ]);

    runtime.setActive(true);
    runtime.setActive(true);

    expect(transport.subscribe).toHaveBeenCalledTimes(2);
    expect(records[0]?.options).toEqual({ query, variables: { static: true } });
    expect(records[1]?.options).toEqual({ query, variables: undefined });
    expect(runtime.isActive()).toBe(true);
    expect(runtime.inspect()).toEqual([
      { key: 'first', active: true, eventCount: 0, lastEventAt: null, errorCount: 0 },
      { key: 'second', active: true, eventCount: 0, lastEventAt: null, errorCount: 0 }
    ]);

    runtime.setActive(false);

    expect(records[0]?.unsubscribe).toHaveBeenCalledTimes(1);
    expect(records[1]?.unsubscribe).toHaveBeenCalledTimes(1);
    expect(runtime.isActive()).toBe(false);
    expect(runtime.inspect().map(row => row.active)).toEqual([false, false]);
  });

  it('deactivation clears pending debounce buckets', () => {
    const { records, transport } = createTransport();
    configureDb({ transport });
    const handler = jest.fn();
    const runtime = createDbSubscriptionRuntime([
      {
        key: 'message',
        query,
        debounce: { ms: 100 },
        onData: handler
      }
    ]);

    runtime.setActive(true);
    records[0]!.handlers.next({ message: { id: '1', value: 1 } });
    runtime.setActive(false);
    jest.advanceTimersByTime(100);

    expect(handler).not.toHaveBeenCalled();
  });

  it('validates payloads from response data and logs skipped malformed payloads', () => {
    const { records, transport } = createTransport();
    const logger = { debug: jest.fn(), error: jest.fn() };
    configureDb({ transport, logger });
    const handler = jest.fn();
    const runtime = createDbSubscriptionRuntime([{ key: 'message', query, onData: handler }]);

    runtime.setActive(true);
    records[0]!.handlers.next(null);
    records[0]!.handlers.next({ message: null });
    records[0]!.handlers.next({ message: ['bad'] });
    jest.setSystemTime(42);
    records[0]!.handlers.next({ message: { id: '1' } });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ id: '1' });
    expect(logger.debug).toHaveBeenCalledTimes(3);
    expect(runtime.inspect()).toEqual([{ key: 'message', active: true, eventCount: 1, lastEventAt: 42, errorCount: 0 }]);
  });

  it('collapses keyed debounce bursts and fires the latest trailing payload per bucket', () => {
    const { records, transport } = createTransport();
    configureDb({ transport });
    const handler = jest.fn();
    const runtime = createDbSubscriptionRuntime<TestPayload>([
      {
        key: 'message',
        query,
        debounce: { ms: 100, keyOf: payload => payload.chatId ?? 'none' },
        onData: handler
      }
    ]);

    runtime.setActive(true);
    records[0]!.handlers.next({ message: { id: 'a1', chatId: 'a', value: 1 } });
    records[0]!.handlers.next({ message: { id: 'a2', chatId: 'a', value: 2 } });
    records[0]!.handlers.next({ message: { id: 'b1', chatId: 'b', value: 3 } });

    jest.advanceTimersByTime(99);
    expect(handler).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith({ id: 'a2', chatId: 'a', value: 2 });
    expect(handler).toHaveBeenCalledWith({ id: 'b1', chatId: 'b', value: 3 });
  });

  it('uses one global debounce bucket when keyOf is omitted', () => {
    const handler = jest.fn();
    const runtime = createDbSubscriptionRuntime<TestPayload>([
      {
        key: 'message',
        query,
        debounce: { ms: 50 },
        onData: handler
      }
    ]);

    runtime.dispatch('message', { id: '1', value: 1 });
    runtime.dispatch('message', { id: '2', value: 2 });
    jest.advanceTimersByTime(50);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ id: '2', value: 2 });
  });

  it('dispatch runs the same validation and debounce pipeline without transport activation', () => {
    const logger = { debug: jest.fn(), error: jest.fn() };
    configureDb({ transport: mockTransport({}), logger });
    const handler = jest.fn();
    const runtime = createDbSubscriptionRuntime<TestPayload>([
      {
        key: 'message',
        query,
        debounce: { ms: 25 },
        onData: handler
      }
    ]);

    runtime.dispatch('message', null);
    jest.setSystemTime(7);
    runtime.dispatch('message', { id: '1' });
    jest.advanceTimersByTime(25);

    expect(handler).toHaveBeenCalledWith({ id: '1' });
    expect(logger.debug).toHaveBeenCalledWith('DbSubscriptionRuntime', 'payload skipped', { key: 'message' });
    expect(runtime.inspect()).toEqual([{ key: 'message', active: false, eventCount: 1, lastEventAt: 7, errorCount: 0 }]);
  });

  it('resubscribes one failed entry with backoff and resets the backoff after recovery', () => {
    const { records, transport } = createTransport();
    const logger = { debug: jest.fn(), error: jest.fn() };
    configureDb({ transport, logger });
    const handler = jest.fn();
    const runtime = createDbSubscriptionRuntime([{ key: 'message', query, onData: handler }]);

    runtime.setActive(true);
    records[0]!.handlers.error(new Error('first'));

    expect(records[0]?.unsubscribe).toHaveBeenCalledTimes(1);
    expect(runtime.inspect()[0]).toMatchObject({ active: false, errorCount: 1 });
    jest.advanceTimersByTime(999);
    expect(transport.subscribe).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1);
    expect(transport.subscribe).toHaveBeenCalledTimes(2);

    records[1]!.handlers.error(new Error('second'));
    jest.advanceTimersByTime(1999);
    expect(transport.subscribe).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    expect(transport.subscribe).toHaveBeenCalledTimes(3);

    records[2]!.handlers.next({ message: { id: 'recovered' } });
    records[2]!.handlers.error(new Error('after recovery'));
    jest.advanceTimersByTime(1000);

    expect(transport.subscribe).toHaveBeenCalledTimes(4);
    expect(handler).toHaveBeenCalledWith({ id: 'recovered' });
    expect(logger.error).toHaveBeenCalledTimes(3);
    expect(runtime.inspect()[0]).toMatchObject({ active: true, eventCount: 1, errorCount: 3 });
  });

  it('throws an actionable error on first activation when transport.subscribe is missing', () => {
    configureDb({ transport: mockTransport({}) });
    const runtime = createDbSubscriptionRuntime([{ key: 'message', query, onData: jest.fn() }]);

    expect(() => runtime.setActive(true)).toThrow('react-native-dblayer: transport.subscribe is required before activating subscription runtime');
    expect(runtime.isActive()).toBe(false);
  });
});
