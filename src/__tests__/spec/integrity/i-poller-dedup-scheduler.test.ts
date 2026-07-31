import { configureDb, defineModelRuntime, f, resetRuntime , createModelStatusPoller } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

describe('poller reset and complete scope deduplication', () => {
  it('captures a fresh generation when restarted after resetRuntime', async () => {
    let calls = 0;
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const poller = createModelStatusPoller({ fetch: async () => ({ ok: true }), apply: () => { calls += 1; }, intervalMs: 1000, maxAttempts: 2 });
    await poller.refresh('row');
    resetRuntime();
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    await poller.refresh('row');
    expect(calls).toBe(2);
  });

  it('keeps one row for a duplicate id in a complete scope payload', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineModelRuntime({
      id: 'CompleteDedupRows', name: 'CompleteDedupRows', fields: { bucket: f.str(), label: f.str() },
      scopes: { byBucket: ({ by: { bucket: 'bucket' } }) }
    });
    rows.scopes.byBucket.seed({ bucket: 'a' }, [
      { id: 'row-1', bucket: 'a', label: 'first' },
      { id: 'row-1', bucket: 'a', label: 'last' }
    ]);
    expect(rows.scopes.byBucket.read({ bucket: 'a' }).map(row => row.id)).toEqual(['row-1']);
  });
});
