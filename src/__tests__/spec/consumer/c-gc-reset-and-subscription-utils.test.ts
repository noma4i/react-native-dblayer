import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { collectGarbage, createDbSubscriptionEffects, defineDbSubscriptionEntry, defineModel, f, registerReset, resetRuntime } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

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
    rows.insertStored({ id: 'r-1', label: 'unreferenced' });
    const report = collectGarbage();
    expect(rows.get('r-1')).toBeUndefined();
    expect(report.evicted.SpecConsumerGcRowsEvict).toBe(1);
  });

  it('keeps rows of a gc-exempt model', () => {
    setupSpecRuntime();
    const rows = createRows('Exempt', 'exempt');
    rows.insertStored({ id: 'r-1', label: 'kept' });
    const report = collectGarbage();
    expect(rows.get('r-1')?.label).toBe('kept');
    expect(report.evicted.SpecConsumerGcRowsExempt).toBeUndefined();
  });

  it('treats mounted readers as GC roots', () => {
    setupSpecRuntime();
    const rows = createRows('Reader');
    rows.insertStored({ id: 'r-1', label: 'watched' });
    const reader = renderCounted(() => rows.use.row('r-1'));
    const report = collectGarbage();
    expect(rows.get('r-1')?.label).toBe('watched');
    expect(report.evicted.SpecConsumerGcRowsReader).toBeUndefined();
    reader.unmount();
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
    const unregister = registerReset(async () => {});
    expect(() => resetRuntime()).toThrow('resetRuntime cannot run async resetters');
    unregister();
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
