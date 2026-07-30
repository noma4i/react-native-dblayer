import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { configureDb, createDbSubscriptionEffects, defineDbSubscriptionEntry, defineModel, f, registerReset, resetRuntime } from '../../../index';
import { collectGarbage, registerGcHost } from '../../../core/gc';
import { createMemoryPlane, createMockTransport, diagnostics, renderCounted, setupSpecRuntime } from '../helpers/harness';

// Named behavioral contracts for GC roots/exemption, reset registration, and subscription utilities.

const createRows = (suffix: string, gc?: 'exempt') =>
  defineModel({
    id: `SpecConsumerGcRows${suffix}`,
    name: `SpecConsumerGcRows${suffix}`,
    fields: { id: f.str(), label: f.str() },
    ...(gc ? { gc } : {})
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
    const rows = defineModel({
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
    const rows = defineModel({ id: 'EffectsResetResolvable', name: 'EffectsResetResolvable', fields: { label: f.str() } });
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
