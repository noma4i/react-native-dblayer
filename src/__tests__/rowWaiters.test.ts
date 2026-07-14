import { configureDb, defineModel, f, patchWhenPresent, type StoragePlane, waitForRow } from '../index';
import { mockTransport } from './helpers/testRuntime';

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

let modelCounter = 0;

const createMessageModel = () =>
  defineModel({
    id: `row-waiter-messages-${modelCounter++}`,
    name: `RowWaiterMessageModel:${modelCounter}`,
    fields: {
      body: f.str(),
      status: f.str().nullable()
    }
  });

describe('row waiters', () => {
  beforeEach(() => {
    configureDb({ storage: createMemoryStorage(), transport: mockTransport({}) });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('patches an existing row immediately', () => {
    const model = createMessageModel();
    model.insertStored({ id: 'message-1', body: 'before', status: null });

    patchWhenPresent(model, 'message-1', { body: 'after' }, { ttlMs: 100 });

    expect(model.get('message-1')).toEqual({ id: 'message-1', body: 'after', status: null });
  });

  it('applies a deferred patch once the row appears', () => {
    jest.useFakeTimers();
    const model = createMessageModel();

    patchWhenPresent(model, 'message-1', { status: 'sent' }, { ttlMs: 100 });
    model.insertStored({ id: 'message-1', body: 'hello', status: null });

    expect(model.get('message-1')).toEqual({ id: 'message-1', body: 'hello', status: 'sent' });
  });

  it('applies multiple deferred updater patches in registration order', () => {
    jest.useFakeTimers();
    const model = createMessageModel();

    patchWhenPresent(model, 'message-1', row => ({ body: `${row.body}-first` }), { ttlMs: 100 });
    patchWhenPresent(model, 'message-1', row => ({ body: `${row.body}-second` }), { ttlMs: 100 });
    model.insertStored({ id: 'message-1', body: 'hello', status: null });

    expect(model.get('message-1')?.body).toBe('hello-first-second');
  });

  it('does not patch a row after the deferred patch ttl expires', () => {
    jest.useFakeTimers();
    const model = createMessageModel();

    patchWhenPresent(model, 'message-1', { status: 'sent' }, { ttlMs: 100 });
    jest.advanceTimersByTime(100);
    model.insertStored({ id: 'message-1', body: 'hello', status: null });

    expect(model.get('message-1')?.status).toBeNull();
  });

  it('resolves waitForRow when the row appears', async () => {
    const model = createMessageModel();
    const waiting = waitForRow(model, 'message-1', { timeoutMs: 100 });

    model.insertStored({ id: 'message-1', body: 'hello', status: null });

    await expect(waiting).resolves.toEqual({ id: 'message-1', body: 'hello', status: null });
  });

  it('resolves waitForRow with undefined after timeout', async () => {
    jest.useFakeTimers();
    const model = createMessageModel();
    const waiting = waitForRow(model, 'message-1', { timeoutMs: 100 });

    jest.advanceTimersByTime(100);

    await expect(waiting).resolves.toBeUndefined();
  });

  it('resolves waitForRow with undefined on abort and unsubscribes before a later row appears', async () => {
    const model = createMessageModel();
    const controller = new AbortController();
    const waiting = waitForRow(model, 'message-1', { timeoutMs: 100, signal: controller.signal });

    controller.abort();
    await expect(waiting).resolves.toBeUndefined();
    model.insertStored({ id: 'message-1', body: 'hello', status: null });

    expect(model.get('message-1')).toEqual({ id: 'message-1', body: 'hello', status: null });
  });
});
