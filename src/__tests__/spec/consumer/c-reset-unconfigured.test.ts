import { bootDb, configureDb, defineModelRuntime, f, resetRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

// Kill-switch lifecycle contract: an unconfigured runtime is trivially clean.

describe('resetRuntime before configureDb', () => {
  it('no-ops so the next configureDb+boot serves data, while a configured reset still clears rows', async () => {
    resetRuntime();

    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({}) });
    await bootDb();
    const rows = defineModelRuntime({
      id: 'SpecResetUnconfigured',
      name: 'SpecResetUnconfigured',
      fields: { label: f.str() }
    });
    rows.insert({ id: 'r-1', label: 'alive' });
    expect(rows.find('r-1')?.label).toBe('alive');
    expect(rows.all().map(row => row.id)).toEqual(['r-1']);

    // Positive counterpart: once configured, the same call is no longer a no-op and clears the row.
    resetRuntime();
    expect(rows.find('r-1')).toBeUndefined();
    expect(rows.all()).toEqual([]);
  });
});
