import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { configureDb, defineModel, defineModelRuntime, defineShape, f, getApplyRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

const refusingStorage = () => {
  const storage = createMemoryPlane();
  const accept = storage.set;
  let refusing = false;
  storage.set = (key, value) => {
    if (refusing) throw new Error('storage is full');
    accept(key, value);
  };
  return { storage, refuse: () => (refusing = true), allow: () => (refusing = false) };
};

/**
 * Storage that cannot take the write is the one moment where the tempting answer is to drop
 * something to make room. Making room is never the answer: a refused CACHE snapshot keeps its
 * model dirty and retries on the next flush, and a refused LEDGER write fails the commit loudly
 * (see the fault-harness ledger contracts). Nothing already durable is ever sacrificed.
 */
describe('storage refusal', () => {
  it('keeps the row in memory and lands it once storage accepts again', () => {
    const { storage, refuse, allow } = refusingStorage();
    configureDb({ storage, transport: createMockTransport() });
    const rows = defineModelRuntime({ id: 'StorageRefusalInsert', name: 'StorageRefusalInsert', fields: { name: f.str() } });
    refuse();

    rows.insert({ id: 'row-1', name: 'first' });
    expect(rows.find('row-1')).toMatchObject({ name: 'first' });
    expect(() => getApplyRuntime().flushCacheSnapshots()).toThrow('storage is full');

    allow();
    getApplyRuntime().flushCacheSnapshots();
    expect(storage.keys('dbl:row:').length).toBeGreaterThan(0);
  });

  it('keeps rows that were already durable when a later flush is refused', () => {
    const { storage, refuse, allow } = refusingStorage();
    configureDb({ storage, transport: createMockTransport() });
    const rows = defineModelRuntime({ id: 'StorageRefusalKeep', name: 'StorageRefusalKeep', fields: { name: f.str() } });
    rows.insert({ id: 'row-1', name: 'first' });
    getApplyRuntime().flushCacheSnapshots();
    diagnostics().reset();
    refuse();

    rows.insert({ id: 'row-2', name: 'second' });
    expect(() => getApplyRuntime().flushCacheSnapshots()).toThrow('storage is full');

    // The refusal delays the new row; it never costs an old one and never reports loss.
    expect(rows.all().map(row => row.id).sort()).toEqual(['row-1', 'row-2']);
    expect(rows.find('row-1')).toMatchObject({ name: 'first' });
    expect(diagnostics().snapshot().dataLossEvents).toEqual([]);
    allow();
  });

  it('reuses the refused delta sequence for the next accepted commit', () => {
    const storage = createMemoryPlane();
    const accept = storage.set;
    let refuseDeltas = false;
    storage.set = (key, value) => {
      if (refuseDeltas && key.startsWith('dbl:delta:')) throw new Error('storage is full');
      accept(key, value);
    };
    configureDb({ storage, transport: createMockTransport() });
    const rows = defineModelRuntime({ id: 'StorageRefusalDeltaSeq', name: 'StorageRefusalDeltaSeq', fields: { name: f.str() } });
    rows.insert({ id: 'row-1', name: 'first' });
    refuseDeltas = true;

    rows.insert({ id: 'row-2', name: 'second' });
    expect(rows.find('row-2')).toMatchObject({ name: 'second' });
    refuseDeltas = false;
    rows.insert({ id: 'row-3', name: 'third' });

    // The refused write rolls the seq counter back: the next accepted commit reuses seq 1
    // instead of leaving a hole in the log.
    expect(storage.keys('dbl:delta:').sort()).toEqual(['dbl:delta:000000000000', 'dbl:delta:000000000001']);
  });

  it('fails the commit loudly on a refused ledger write, leaving reads alive and the row unapplied', async () => {
    type Row = { id: string; label: string };
    const storage = createMemoryPlane();
    const accept = storage.set;
    storage.set = (key, value) => {
      if (key === 'dbl:ops') throw new Error('storage is full');
      accept(key, value);
    };
    configureDb({ storage, transport: createMockTransport({ mutation: () => new Promise(() => undefined) }) });
    const document: TypedDocumentNode<{ createRow: { row: Row } }, { input: { label: string } }> = { kind: Kind.DOCUMENT, definitions: [] };
    const rows = defineModel('StorageRefusalLedger', {
      schema: defineShape<Row>()({ label: f.str() }),
      maintenance: { dropTempRowsAfterMs: 60_000 },
      actions: owner => ({
        create: owner.gql.action(document, {
          mode: 'request',
          result: 'createRow',
          variables: (input: { label: string }) => ({ input }),
          optimistic: { root: { insert: { select: ({ input, tempId }) => ({ id: tempId, label: input.label }) } } },
          root: { insert: { select: ({ data }) => data.createRow.row } }
        })
      })
    });

    // The ledger carries the user's unacked write: a refused ledger write fails the WHOLE
    // commit before anything applies - no optimistic row, and reads stay alive (not poisoned).
    await expect(rows.actions.create.run({ label: 'local' })).rejects.toThrow('storage is full');
    expect(rows.where({}).read()).toEqual([]);
  });
});
