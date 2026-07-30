import { advanceRuntimeGeneration, defineModel, defineModelRuntime, defineShape, f, updateWhenRowExists, resetRuntime, waitForRow } from '../../testApi';
import { getCommitBus } from '../../../dsl/configure';
import { diagnostics, setupSpecRuntime } from '../helpers/harness';

// Named behavioral contracts for commit-bus row waiters.

const createRows = (suffix: string) =>
  defineModelRuntime({
    id: `SpecConsumerRowWaiters${suffix}`,
    name: `SpecConsumerRowWaiters${suffix}`,
    fields: { id: f.str(), label: f.str() }
  });

describe('updateWhenRowExists', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('patches immediately when the row already exists', () => {
    setupSpecRuntime();
    const rows = createRows('Now');
    rows.insert({ id: 'r-1', label: 'before' });
    updateWhenRowExists(rows, 'r-1', { label: 'after' }, { ttlMs: 1000 });
    expect(rows.find('r-1')?.label).toBe('after');
  });

  it('defers the patch until the row appears', () => {
    jest.useFakeTimers();
    setupSpecRuntime();
    const rows = createRows('Defer');
    updateWhenRowExists(rows, 'r-1', row => ({ label: `${row.label}-patched` }), { ttlMs: 60000 });
    rows.insert({ id: 'r-1', label: 'base' });
    expect(rows.find('r-1')?.label).toBe('base-patched');
  });

  it('keeps waiting when a matching commit does not contain the row yet', () => {
    jest.useFakeTimers();
    setupSpecRuntime();
    const rows = createRows('MissingCommit');
    updateWhenRowExists(rows, 'r-1', { label: 'patched' }, { ttlMs: 60000 });
    getCommitBus().publish({
      rows: [{ model: rows.modelId, id: 'r-1', fields: ['label'], kind: 'upsert' }],
      scopes: [],
      mode: 'delta'
    });
    rows.insert({ id: 'r-1', label: 'base' });

    expect(rows.find('r-1')?.label).toBe('patched');
  });

  it('drops the deferred patch after ttl', () => {
    jest.useFakeTimers();
    setupSpecRuntime();
    const rows = createRows('Ttl');
    updateWhenRowExists(rows, 'r-1', { label: 'late' }, { ttlMs: 10 });
    jest.advanceTimersByTime(11);
    rows.insert({ id: 'r-1', label: 'base' });
    expect(rows.find('r-1')?.label).toBe('base');
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'deferred-patch-timeout', model: rows.modelId, count: 1 });
  });

  it('does not apply a deferred patch across resetRuntime (generation fence)', () => {
    jest.useFakeTimers();
    setupSpecRuntime();
    const rows = createRows('Fence');
    updateWhenRowExists(rows, 'r-1', { label: 'stale' }, { ttlMs: 60000 });
    resetRuntime();
    setupSpecRuntime();
    rows.insert({ id: 'r-1', label: 'fresh' });
    expect(rows.find('r-1')?.label).toBe('fresh');
  });

  it('unsubscribes from the commit bus immediately on resetRuntime instead of waiting for ttl', () => {
    jest.useFakeTimers();
    setupSpecRuntime();
    const rows = createRows('ImmediateUnsub');
    const before = getCommitBus().subscriberCount();
    updateWhenRowExists(rows, 'r-1', { label: 'stale' }, { ttlMs: 60000 });
    expect(getCommitBus().subscriberCount()).toBe(before + 1);

    resetRuntime();

    expect(getCommitBus().subscriberCount()).toBe(before);
  });
});

describe('waitForRow', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves immediately with an existing row', async () => {
    setupSpecRuntime();
    const rows = createRows('Immediate');
    rows.insert({ id: 'r-1', label: 'here' });
    await expect(waitForRow(rows, 'r-1', { timeoutMs: 1000 })).resolves.toMatchObject({ id: 'r-1', label: 'here' });
  });

  it('accepts the public model facade directly', async () => {
    setupSpecRuntime();
    const Rows = defineModel('facade-waiter-rows', {
      schema: defineShape<{ id: string; label: string }>()({ label: f.str() })
    });
    Rows.insert({ id: 'r-1', label: 'here' });
    await expect(waitForRow(Rows, 'r-1', { timeoutMs: 1000 })).resolves.toMatchObject({ id: 'r-1', label: 'here' });
  });

  it('keys a deferred public model waiter by the facade key', async () => {
    setupSpecRuntime();
    const Rows = defineModel('facade-deferred-waiter-rows', {
      schema: defineShape<{ id: string; label: string }>()({ label: f.str() })
    });
    const pending = waitForRow(Rows, 'r-1', { timeoutMs: 1000 });

    Rows.insert({ id: 'r-1', label: 'arrived' });

    await expect(pending).resolves.toMatchObject({ id: 'r-1', label: 'arrived' });
  });

  it('resolves once the row appears later', async () => {
    setupSpecRuntime();
    const rows = createRows('Later');
    const pending = waitForRow(rows, 'r-1', { timeoutMs: 1000 });
    rows.insert({ id: 'r-1', label: 'arrived' });
    await expect(pending).resolves.toMatchObject({ id: 'r-1', label: 'arrived' });
  });

  it('resolves undefined on timeout', async () => {
    jest.useFakeTimers();
    setupSpecRuntime();
    const rows = createRows('Timeout');
    const pending = waitForRow(rows, 'missing', { timeoutMs: 50 });
    jest.advanceTimersByTime(51);
    await expect(pending).resolves.toBeUndefined();
  });

  it('resolves undefined on abort', async () => {
    setupSpecRuntime();
    const rows = createRows('Abort');
    const controller = new AbortController();
    const pending = waitForRow(rows, 'missing', { timeoutMs: 60000, signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
  });

  it('does not subscribe when the signal is already aborted', async () => {
    setupSpecRuntime();
    const rows = createRows('AlreadyAborted');
    const controller = new AbortController();
    controller.abort();
    const before = getCommitBus().subscriberCount();
    const pending = waitForRow(rows, 'missing', { timeoutMs: 60000, signal: controller.signal });

    expect(getCommitBus().subscriberCount()).toBe(before);
    await expect(pending).resolves.toBeUndefined();
  });

  it('resolves undefined when its generation becomes stale before the row arrives', async () => {
    setupSpecRuntime();
    const rows = createRows('Generation');
    const pending = waitForRow(rows, 'r-1', { timeoutMs: 60000 });
    advanceRuntimeGeneration();
    getCommitBus().publish({
      rows: [{ model: rows.modelId, id: 'r-1', fields: ['label'], kind: 'upsert' }],
      scopes: [],
      mode: 'delta'
    });

    await expect(pending).resolves.toBeUndefined();
  });
});
