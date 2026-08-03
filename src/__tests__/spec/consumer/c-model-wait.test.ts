import { defineModel, defineShape, f, getCommitBus, resetRuntime } from '../../testApi';
import { setupSpecRuntime } from '../helpers/harness';

const createRows = (suffix: string) =>
  defineModel(`spec-consumer-model-wait-${suffix}`, {
    schema: defineShape<{ id: string; label: string }>()({ label: f.str() })
  });

describe('Model.wait', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves immediately with an existing row without subscribing', async () => {
    setupSpecRuntime();
    const Rows = createRows('Immediate');
    Rows.insert({ id: 'r-1', label: 'here' });
    const before = getCommitBus().subscriberCount();

    await expect(Rows.wait('r-1', { timeoutMs: 1000 })).resolves.toMatchObject({ id: 'r-1', label: 'here' });
    expect(getCommitBus().subscriberCount()).toBe(before);
  });

  it('resolves undefined for nullish ids without subscribing', async () => {
    setupSpecRuntime();
    const Rows = createRows('Nullish');
    const before = getCommitBus().subscriberCount();

    await expect(Rows.wait(null, { timeoutMs: 1000 })).resolves.toBeUndefined();
    await expect(Rows.wait(undefined, { timeoutMs: 1000 })).resolves.toBeUndefined();
    expect(getCommitBus().subscriberCount()).toBe(before);
  });

  it('subscribes to only the exact row dependency and resolves on committed arrival', async () => {
    setupSpecRuntime();
    const Rows = createRows('Arrival');
    const OtherRows = createRows('Other');
    const before = getCommitBus().subscriberCount();
    const pending = Rows.wait('r-1', { timeoutMs: 1000 });

    expect(getCommitBus().subscriberCount()).toBe(before + 1);
    expect(getCommitBus().activeDependencies()).toEqual([{ kind: 'row', model: Rows.key, id: 'r-1' }]);

    OtherRows.insert({ id: 'r-1', label: 'other' });
    Rows.insert({ id: 'other', label: 'other-id' });
    await Promise.resolve();
    expect(getCommitBus().subscriberCount()).toBe(before + 1);

    Rows.insert({ id: 'r-1', label: 'arrived' });

    await expect(pending).resolves.toMatchObject({ id: 'r-1', label: 'arrived' });
    expect(getCommitBus().subscriberCount()).toBe(before);
    expect(getCommitBus().activeDependencies()).toEqual([]);
  });

  it('does not apply a deferred patch when the row arrives', async () => {
    setupSpecRuntime();
    const Rows = createRows('ReadOnly');
    const pending = Rows.wait('r-1', { timeoutMs: 1000 });

    Rows.insert({ id: 'r-1', label: 'arrived' });

    await expect(pending).resolves.toMatchObject({ id: 'r-1', label: 'arrived' });
    expect(Rows.find('r-1')).toMatchObject({ id: 'r-1', label: 'arrived' });
  });

  it('resolves undefined on timeout and removes its timer and subscription', async () => {
    jest.useFakeTimers();
    setupSpecRuntime();
    const Rows = createRows('Timeout');
    const beforeSubscribers = getCommitBus().subscriberCount();
    const beforeTimers = jest.getTimerCount();
    const pending = Rows.wait('missing', { timeoutMs: 50 });

    expect(getCommitBus().subscriberCount()).toBe(beforeSubscribers + 1);
    expect(jest.getTimerCount()).toBe(beforeTimers + 1);
    jest.advanceTimersByTime(50);

    await expect(pending).resolves.toBeUndefined();
    expect(getCommitBus().subscriberCount()).toBe(beforeSubscribers);
    expect(jest.getTimerCount()).toBe(beforeTimers);
  });

  it('resolves undefined on abort and removes its timer and subscription', async () => {
    jest.useFakeTimers();
    setupSpecRuntime();
    const Rows = createRows('Abort');
    const controller = new AbortController();
    const beforeSubscribers = getCommitBus().subscriberCount();
    const beforeTimers = jest.getTimerCount();
    const pending = Rows.wait('missing', { timeoutMs: 60000, signal: controller.signal });

    expect(getCommitBus().subscriberCount()).toBe(beforeSubscribers + 1);
    expect(jest.getTimerCount()).toBe(beforeTimers + 1);
    controller.abort();

    await expect(pending).resolves.toBeUndefined();
    expect(getCommitBus().subscriberCount()).toBe(beforeSubscribers);
    expect(jest.getTimerCount()).toBe(beforeTimers);
  });

  it('resolves undefined without subscribing when the signal is already aborted', async () => {
    jest.useFakeTimers();
    setupSpecRuntime();
    const Rows = createRows('AlreadyAborted');
    const controller = new AbortController();
    controller.abort();
    const beforeSubscribers = getCommitBus().subscriberCount();
    const beforeTimers = jest.getTimerCount();

    const pending = Rows.wait('missing', { timeoutMs: 60000, signal: controller.signal });

    expect(getCommitBus().subscriberCount()).toBe(beforeSubscribers);
    expect(jest.getTimerCount()).toBe(beforeTimers);
    await expect(pending).resolves.toBeUndefined();
  });

  it('resolves undefined on resetRuntime and removes its timer and subscription', async () => {
    jest.useFakeTimers();
    setupSpecRuntime();
    const Rows = createRows('Reset');
    const beforeSubscribers = getCommitBus().subscriberCount();
    const beforeTimers = jest.getTimerCount();
    const pending = Rows.wait('missing', { timeoutMs: 60000 });

    expect(getCommitBus().subscriberCount()).toBe(beforeSubscribers + 1);
    expect(jest.getTimerCount()).toBe(beforeTimers + 1);
    resetRuntime();

    await expect(pending).resolves.toBeUndefined();
    expect(getCommitBus().subscriberCount()).toBe(beforeSubscribers);
    expect(jest.getTimerCount()).toBe(beforeTimers);
  });
});
