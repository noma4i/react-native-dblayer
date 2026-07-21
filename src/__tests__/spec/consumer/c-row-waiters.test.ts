import { defineModel, f, patchWhenRowExists, resetRuntime, waitForRow } from '../../../index';
import { setupSpecRuntime } from '../helpers/harness';

// Named behavioral contracts for commit-bus row waiters.

const createRows = (suffix: string) =>
  defineModel({
    id: `SpecConsumerRowWaiters${suffix}`,
    name: `SpecConsumerRowWaiters${suffix}`,
    fields: { id: f.str(), label: f.str() }
  });

describe('patchWhenRowExists', () => {
  it('patches immediately when the row already exists', () => {
    setupSpecRuntime();
    const rows = createRows('Now');
    rows.insertStored({ id: 'r-1', label: 'before' });
    patchWhenRowExists(rows, 'r-1', { label: 'after' }, { ttlMs: 1000 });
    expect(rows.get('r-1')?.label).toBe('after');
  });

  it('defers the patch until the row appears', () => {
    jest.useFakeTimers();
    setupSpecRuntime();
    const rows = createRows('Defer');
    patchWhenRowExists(rows, 'r-1', row => ({ label: `${row.label}-patched` }), { ttlMs: 60000 });
    rows.insertStored({ id: 'r-1', label: 'base' });
    expect(rows.get('r-1')?.label).toBe('base-patched');
    jest.useRealTimers();
  });

  it('drops the deferred patch after ttl', () => {
    jest.useFakeTimers();
    setupSpecRuntime();
    const rows = createRows('Ttl');
    patchWhenRowExists(rows, 'r-1', { label: 'late' }, { ttlMs: 10 });
    jest.advanceTimersByTime(11);
    rows.insertStored({ id: 'r-1', label: 'base' });
    expect(rows.get('r-1')?.label).toBe('base');
    jest.useRealTimers();
  });

  it('does not apply a deferred patch across resetRuntime (generation fence)', () => {
    jest.useFakeTimers();
    setupSpecRuntime();
    const rows = createRows('Fence');
    patchWhenRowExists(rows, 'r-1', { label: 'stale' }, { ttlMs: 60000 });
    resetRuntime();
    setupSpecRuntime();
    rows.insertStored({ id: 'r-1', label: 'fresh' });
    expect(rows.get('r-1')?.label).toBe('fresh');
    jest.useRealTimers();
  });
});

describe('waitForRow', () => {
  it('resolves immediately with an existing row', async () => {
    setupSpecRuntime();
    const rows = createRows('Immediate');
    rows.insertStored({ id: 'r-1', label: 'here' });
    await expect(waitForRow(rows, 'r-1', { timeoutMs: 1000 })).resolves.toMatchObject({ id: 'r-1', label: 'here' });
  });

  it('resolves once the row appears later', async () => {
    setupSpecRuntime();
    const rows = createRows('Later');
    const pending = waitForRow(rows, 'r-1', { timeoutMs: 1000 });
    rows.insertStored({ id: 'r-1', label: 'arrived' });
    await expect(pending).resolves.toMatchObject({ id: 'r-1', label: 'arrived' });
  });

  it('resolves undefined on timeout', async () => {
    jest.useFakeTimers();
    setupSpecRuntime();
    const rows = createRows('Timeout');
    const pending = waitForRow(rows, 'missing', { timeoutMs: 50 });
    jest.advanceTimersByTime(51);
    await expect(pending).resolves.toBeUndefined();
    jest.useRealTimers();
  });

  it('resolves undefined on abort', async () => {
    setupSpecRuntime();
    const rows = createRows('Abort');
    const controller = new AbortController();
    const pending = waitForRow(rows, 'missing', { timeoutMs: 60000, signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
  });
});
