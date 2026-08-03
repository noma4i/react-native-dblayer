import { configureDb, defineModelRuntime, f, registerReset, resetRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport, setupSpecRuntime } from '../helpers/harness';

// Named behavioral contracts for the logout wipe, reset registration, and subscription utilities.

describe('resetRuntime logout wipe', () => {
  it('deletes every persisted key - rows, scopes, journal, ledger, manifest - in one synchronous call', () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
    const rows = defineModelRuntime({
      id: 'SpecConsumerLogoutWipe',
      name: 'SpecConsumerLogoutWipe',
      fields: { id: f.str(), label: f.str() },
      scopes: { all: { sort: 'server-order' } }
    });
    rows.scopes.all.seed({}, [{ id: 'row-1', label: 'persisted' }]);
    rows.insert({ id: 'row-2', label: 'written' });
    expect(storage.keys('').length).toBeGreaterThan(0);

    resetRuntime();

    expect(storage.keys('')).toEqual([]);
    expect(rows.find('row-1')).toBeUndefined();
    expect(rows.find('row-2')).toBeUndefined();
  });
});

describe('registerReset', () => {
  it('runs registered resetters on resetRuntime and stops after unregister', () => {
    setupSpecRuntime();
    const calls: string[] = [];
    const unregister = registerReset(() => {
      calls.push('reset');
    });
    resetRuntime();
    expect(calls).toEqual(['reset']);
    unregister();
    setupSpecRuntime();
    resetRuntime();
    expect(calls).toEqual(['reset']);
  });

  it('throws when a resetter returns a promise', () => {
    setupSpecRuntime();
    const unregister = registerReset((async () => {}) as unknown as () => void);
    try {
      expect(() => resetRuntime()).toThrow(AggregateError);
    } finally {
      unregister();
    }
  });

  it('rejects a non-Promise thenable returned by a JavaScript resetter', () => {
    setupSpecRuntime();
    const unregister = registerReset((() => ({ then: () => undefined })) as unknown as () => void);
    try {
      expect(() => resetRuntime()).toThrow(AggregateError);
    } finally {
      unregister();
    }
  });

  it('rejects a function thenable returned by a JavaScript resetter', () => {
    setupSpecRuntime();
    const thenable = Object.assign(() => undefined, { then: () => undefined });
    const unregister = registerReset((() => thenable) as unknown as () => void);
    try {
      expect(() => resetRuntime()).toThrow(AggregateError);
    } finally {
      unregister();
    }
  });

  it('reports resetter failures during runtime reconfiguration', () => {
    setupSpecRuntime();
    const unregister = registerReset(() => {
      throw new Error('reset failed');
    });
    try {
      expect(() => configureDb({ storage: createMemoryPlane(), transport: createMockTransport() })).toThrow(AggregateError);
    } finally {
      unregister();
    }
  });
});
