import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { configureDb, createDbSubscriptionEffects, defineDbSubscriptionEntry, defineModelRuntime, f, registerReset, resetRuntime } from '../../testApi';
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
