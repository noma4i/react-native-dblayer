import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import {
  configureDb,
  createDbSubscriptionEffects,
  createModelStore,
  defineDbSubscriptionEntry,
  defineModelRuntime,
  f,
  getOperationState,
  registerApplyTarget,
  registerReset,
  resetRuntime
} from '../../testApi';
import { collectGarbage, registerGcHost } from '../../../core/gc';
import { createMemoryPlane, createMockTransport, diagnostics, renderCounted, setupSpecRuntime } from '../helpers/harness';

// Named behavioral contracts for GC roots/exemption, reset registration, and subscription utilities.

const createRows = (suffix: string, gc?: 'exempt') =>
  defineModelRuntime({
    id: `SpecConsumerGcRows${suffix}`,
    name: `SpecConsumerGcRows${suffix}`,
    fields: { id: f.str(), label: f.str() },
    ...(gc ? { gc } : {})
  });

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

describe('collectGarbage', () => {
  it('evicts rows of a non-exempt model that have no scope, reader or operation roots', () => {
    setupSpecRuntime();
    const rows = createRows('Evict');
    rows.insert({ id: 'r-1', label: 'unreferenced' });
    const report = collectGarbage();
    expect(rows.find('r-1')).toBeUndefined();
    expect(report.evicted.SpecConsumerGcRowsEvict).toBe(1);
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'gc-row-eviction', model: rows.modelId, count: 1 });
  });

  it('keeps rows of a gc-exempt model', () => {
    setupSpecRuntime();
    const rows = createRows('Exempt', 'exempt');
    rows.insert({ id: 'r-1', label: 'kept' });
    const report = collectGarbage();
    expect(rows.find('r-1')?.label).toBe('kept');
    expect(report.evicted.SpecConsumerGcRowsExempt).toBeUndefined();
  });

  it('reports removal of an inactive scope', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ query: async <TData,>() => ({ data: { rows: [{ id: 'r-1', bucket: 'a', label: 'idle' }] } as TData }) })
    });
    const rows = defineModelRuntime({
      id: 'SpecConsumerGcIdleScope',
      name: 'SpecConsumerGcIdleScope',
      fields: { bucket: f.str(), label: f.str() },
      scopes: { feed: ({ by: { bucket: 'bucket' } }) },
      maintenance: { dropIdleScopesAfterMs: 0 }
    });
    const query = rows.query<{ rows: Array<{ id: string; bucket: string; label: string }> }, { bucket: string }, { bucket: string }, { id: string; bucket: string; label: string }>('idle-scope', {
      document: { kind: 'Document', definitions: [] } as never,
      vars: value => value,
      select: data => data.rows,
      into: rows.scopes.feed,
      coverage: 'complete'
    });

    await query.fetch({ bucket: 'a' });
    collectGarbage();

    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'gc-scope-removal', model: rows.modelId, count: 1 });
  });

  it('treats mounted readers as GC roots', () => {
    setupSpecRuntime();
    const rows = createRows('Reader');
    rows.insert({ id: 'r-1', label: 'watched' });
    const reader = renderCounted(() => rows.use.find('r-1'));
    const report = collectGarbage();
    expect(rows.find('r-1')?.label).toBe('watched');
    expect(report.evicted.SpecConsumerGcRowsReader).toBeUndefined();
    reader.unmount();
  });

  it('visits each reachable row once in a large relation chain', () => {
    setupSpecRuntime();
    const size = 1000;
    let referenceReads = 0;
    const unregister = registerGcHost('SpecGcLinearTraversal', {
      modelId: 'SpecGcLinearTraversal',
      exempt: true,
      rowIds: () => Array.from({ length: size }, (_value, index) => `row-${index}`),
      hasRow: id => Number(id.slice(4)) < size,
      scopeKeys: () => [],
      scopeEntryIds: () => [],
      detachScopeEntries: () => {},
      scopeEntryCount: () => 0,
      removeScope: () => {},
      evict: () => false,
      referencesOf: id => {
        referenceReads += 1;
        const next = Number(id.slice(4)) + 1;
        return next < size ? [{ model: 'SpecGcLinearTraversal', id: `row-${next}` }] : [];
      }
    });

    try {
      collectGarbage();
      expect(referenceReads).toBe(size);
    } finally {
      unregister();
    }
  });

  it('detaches missing scope members and preserves recently accessed scopes', () => {
    setupSpecRuntime();
    const store = createModelStore({
      modelId: 'SpecGcMissingMembership',
      now: () => Date.now(),
      storage: createMemoryPlane(),
      prefix: () => 'gc-missing-membership:',
      applyWriteGate: (_previous, incoming) => incoming
    });
    const unregisterTarget = registerApplyTarget(
      'SpecGcMissingMembership',
      {
        persistEntries: () => [],
        ackPersist: () => undefined
      } as never
    );
    const detached: Array<{ scopeKey: string; ids: string[] }> = [];
    const removed: string[] = [];
    const unregister = registerGcHost('SpecGcMissingMembership', {
      modelId: 'SpecGcMissingMembership',
      exempt: false,
      rowIds: () => [],
      hasRow: () => false,
      scopeKeys: () => ['recent'],
      scopeEntryIds: () => ['missing'],
      detachScopeEntries: (scopeKey, ids) => detached.push({ scopeKey, ids }),
      scopeEntryCount: () => 1,
      removeScope: scopeKey => removed.push(scopeKey),
      evict: () => false,
      referencesOf: () => [],
      idleScopeAfterMs: () => 60_000,
      scopeLastAccess: () => Date.now()
    });

    try {
      collectGarbage();
      expect(detached).toEqual([{ scopeKey: 'recent', ids: ['missing'] }]);
      expect(removed).toEqual([]);
      expect(diagnostics().snapshot().dataLossEvents).toContainEqual({
        mechanism: 'gc-scope-membership-detach',
        model: 'SpecGcMissingMembership',
        count: 1
      });
    } finally {
      unregister();
      unregisterTarget();
      store.dispose();
    }
  });

  it('preserves a scope while a reader declares it as a live dependency', () => {
    setupSpecRuntime();
    const rows = defineModelRuntime({
      id: 'SpecGcLiveScope',
      name: 'SpecGcLiveScope',
      fields: { bucket: f.str(), label: f.str() },
      scopes: { feed: ({ by: { bucket: 'bucket' } }) },
      maintenance: { dropIdleScopesAfterMs: 0 }
    });
    rows.scopes.feed.seed({ bucket: 'a' }, [{ id: 'row-1', bucket: 'a', label: 'kept' }]);
    const reader = renderCounted(() => rows.scopes.feed.use({ bucket: 'a' }));

    collectGarbage();

    expect(reader.result()).toMatchObject([{ id: 'row-1', label: 'kept' }]);
    reader.unmount();
  });

  it('accepts operations without rowIds as roots with an empty row-id set', () => {
    setupSpecRuntime();
    getOperationState().begin({
      operationId: 'gc-no-row-ids',
      model: 'SpecGcNoRowIds',
      tempIds: [],
      intent: 'insert',
      idempotencyKey: 'gc-no-row-ids',
      createdAt: 1
    });

    expect(() => collectGarbage()).not.toThrow();
    getOperationState().close('gc-no-row-ids', 'committed');
  });

  it('skips a queued reference whose model unregisters during the sweep', () => {
    setupSpecRuntime();
    let unregisterReferenced = (): void => undefined;
    const unregisterRoot = registerGcHost('SpecGcUnregisterRoot', {
      modelId: 'SpecGcUnregisterRoot',
      exempt: true,
      rowIds: () => ['root'],
      hasRow: () => true,
      scopeKeys: () => [],
      scopeEntryIds: () => [],
      detachScopeEntries: () => undefined,
      scopeEntryCount: () => 0,
      removeScope: () => undefined,
      evict: () => false,
      referencesOf: () => [{ model: 'SpecGcUnregisterReferenced', id: 'child' }]
    });
    unregisterReferenced = registerGcHost('SpecGcUnregisterReferenced', {
      modelId: 'SpecGcUnregisterReferenced',
      exempt: false,
      rowIds: () => [],
      hasRow: () => {
        unregisterReferenced();
        return true;
      },
      scopeKeys: () => [],
      scopeEntryIds: () => [],
      detachScopeEntries: () => undefined,
      scopeEntryCount: () => 0,
      removeScope: () => undefined,
      evict: () => false,
      referencesOf: () => []
    });

    try {
      expect(() => collectGarbage()).not.toThrow();
    } finally {
      unregisterRoot();
      unregisterReferenced();
    }
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

describe('createDbSubscriptionEffects', () => {
  it('keeps one stable effects identity while configure swaps implementations and reset restores noop', () => {
    const channel = createDbSubscriptionEffects({ onPing: (_value: string) => {} });
    const table = channel.effects;
    const seen: string[] = [];
    channel.configure({
      onPing: value => {
        seen.push(value);
      }
    });
    expect(channel.effects).toBe(table);
    table.onPing('a');
    expect(seen).toEqual(['a']);
    channel.reset();
    table.onPing('b');
    expect(seen).toEqual(['a']);
  });

  it('keeps ingest effect names resolvable after the channel resets to noop', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const channel = createDbSubscriptionEffects({ onEchoResolvable: (_payload: unknown) => {} });
    const rows = defineModelRuntime({ id: 'EffectsResetResolvable', name: 'EffectsResetResolvable', fields: { label: f.str() } });
    const ingest = rows.ingest({ evt: { payload: data => data, effect: { name: 'onEchoResolvable', when: 'before' } } });
    const seen: unknown[] = [];

    channel.reset();
    channel.configure({
      onEchoResolvable: payload => {
        seen.push(payload);
      }
    });
    ingest.apply('evt', { id: 'x' });

    expect(seen).toEqual([{ id: 'x' }]);
  });
});

describe('defineDbSubscriptionEntry', () => {
  it('returns the entry preserving key, document, vars and handler', () => {
    type PingResult = { chatPing: { id: string } };
    const document = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<PingResult, never>;
    const onData = (_payload: PingResult['chatPing']): void => {};
    const entry = defineDbSubscriptionEntry({ key: 'chatPing', query: document, onData, debounce: { ms: 50 } });
    expect(entry.key).toBe('chatPing');
    expect(entry.query).toBe(document);
    expect(entry.onData).toBe(onData);
    expect(entry.debounce).toEqual({ ms: 50 });
  });
});
