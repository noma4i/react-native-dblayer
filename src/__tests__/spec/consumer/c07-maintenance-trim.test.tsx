import { act } from 'react';
import { configureDb, defineModel, f } from '../../legacyTestApi';
import { bootDb } from '../../../dsl/lifecycle';
import { collectGarbage } from '../../../core/gc';
import { clearFailedOptimisticMutation } from '../../../dsl/mutationRuntime';
import { DB_FORMAT_VERSION, computeSchemaFingerprint, writePersistenceManifest } from '../../../core/schemaManifest';
import { createMemoryPlane, createMockTransport, diagnostics, renderCounted, setupSpecRuntime, settle } from '../helpers/harness';

type MessageRow = { id: string; chatId: string; sequence: number; payload: string };
type MessageResponse = { rows: MessageRow[] };

const document = { kind: 'Document', definitions: [] } as never;
const persistCurrentManifest = () => writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprint: computeSchemaFingerprint(), dataVersion: null });

const createMessageModel = (limit: number, protect?: () => Set<string>) =>
  defineModel({
    id: `SpecConsumerMessagesMaint${limit}`,
    name: `SpecConsumerMessagesMaint${limit}`,
    fields: {
      id: f.str(),
      chatId: f.str(),
      sequence: f.num(),
      payload: f.str()
    },
    scopes: {
      byChat: ({
        by: { chatId: 'chatId' },
        sort: { comparator: (left: MessageRow, right: MessageRow) => right.sequence - left.sequence }
      })
    },
    maintenance: {
      maxRowsPerScope: [
        {
          scopeField: 'chatId',
          limit,
          compare: (left: MessageRow, right: MessageRow) => right.sequence - left.sequence,
          ...(protect
            ? {
                protect: () => {
                  const protectedRows = protect();
                  return (row: MessageRow) => protectedRows.has(row.id);
                }
              }
            : {})
        }
      ]
    }
  });

describe('maintenance trim contracts', () => {
  it('keeps newest rows in one scope after boot trim and leaves other scopes untouched', async () => {
    setupSpecRuntime();
    const limit = 3;
    const messages = createMessageModel(limit);
    persistCurrentManifest();

    for (let sequence = 1; sequence <= 5; sequence += 1) {
      messages.insert({ id: `chat-a-${sequence}`, chatId: 'chat-a', sequence, payload: `row-${sequence}` });
    }
    for (let sequence = 1; sequence <= 2; sequence += 1) {
      messages.insert({ id: `chat-b-${sequence}`, chatId: 'chat-b', sequence, payload: `other-${sequence}` });
    }

    await bootDb();

    expect(messages.scopes.byChat.read({ chatId: 'chat-a' }).map(row => row.sequence)).toEqual([5, 4, 3]);
    expect(messages.scopes.byChat.read({ chatId: 'chat-b' })).toHaveLength(2);
  });

  it('keeps protected ids in scope even when they are older than the limit', async () => {
    setupSpecRuntime();
    const protectIds = new Set(['chat-a-protected']);
    const messages = createMessageModel(2, () => protectIds);
    persistCurrentManifest();

    messages.insert({ id: 'chat-a-protected', chatId: 'chat-a', sequence: 1, payload: 'protected-old' });
    messages.insert({ id: 'chat-a-2', chatId: 'chat-a', sequence: 2, payload: 'new-2' });
    messages.insert({ id: 'chat-a-3', chatId: 'chat-a', sequence: 3, payload: 'new-3' });
    messages.insert({ id: 'chat-a-4', chatId: 'chat-a', sequence: 4, payload: 'new-4' });
    const reader = renderCounted(() => messages.scopes.byChat.use({ chatId: 'chat-a' }));

    await bootDb();
    await settle();

    expect(messages.scopes.byChat.read({ chatId: 'chat-a' }).map(row => row.id)).toEqual(['chat-a-4', 'chat-a-3', 'chat-a-protected']);
    expect(reader.result().map(row => row.id)).toEqual(['chat-a-4', 'chat-a-3', 'chat-a-protected']);
    reader.unmount();
  });

  it('resolves maintenance comparator ties by codepoint id order', async () => {
    setupSpecRuntime();
    const messages = createMessageModel(1);
    persistCurrentManifest();
    messages.insertMany([
      { id: 'z-row', chatId: 'chat-a', sequence: 1, payload: 'z' },
      { id: 'a-row', chatId: 'chat-a', sequence: 1, payload: 'a' }
    ]);

    await bootDb();

    expect(messages.scopes.byChat.read({ chatId: 'chat-a' }).map(row => row.id)).toEqual(['a-row']);
  });

  it('rerenders a mounted scope reader exactly once for a trim batch', async () => {
    setupSpecRuntime();
    const messages = createMessageModel(2);
    persistCurrentManifest();
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      messages.insert({ id: `chat-a-${sequence}`, chatId: 'chat-a', sequence, payload: `row-${sequence}` });
    }

    const scopeReader = renderCounted(() => messages.scopes.byChat.use({ chatId: 'chat-a' }));
    const before = scopeReader.renders();
    await bootDb();
    await settle();

    expect(scopeReader.renders() - before).toBe(1);
    expect(scopeReader.result().map(row => row.id)).toEqual(['chat-a-4', 'chat-a-3']);
    scopeReader.unmount();
  });

  it('keeps the comparator-first rows when scope retention trims a complete snapshot', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({
        data: {
          rows: [1, 4, 2, 3].map(sequence => ({ id: `chat-a-${sequence}`, chatId: 'chat-a', sequence, payload: `row-${sequence}` }))
        } as TData
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const messages = defineModel({
      id: 'SpecConsumerMessagesRetention',
      name: 'SpecConsumerMessagesRetention',
      fields: { id: f.str(), chatId: f.str(), sequence: f.num(), payload: f.str() },
      scopes: {
        byChat: ({
          by: { chatId: 'chatId' },
          sort: { comparator: (left, right) => right.sequence - left.sequence },
          retention: { maxRows: 2 }
        })
      }
    });
    const query = messages.query<MessageResponse, { chatId: string }, { chatId: string }, MessageRow>('retention', {
      document,
      vars: value => value,
      select: data => data.rows,
      into: messages.scopes.byChat,
      coverage: 'complete'
    });
    const reader = renderCounted(() => messages.scopes.byChat.use({ chatId: 'chat-a' }));
    const before = reader.renders();

    await act(async () => query.fetch({ chatId: 'chat-a' }));

    expect(reader.renders() - before).toBe(1);
    expect(reader.result().map(row => row.id)).toEqual(['chat-a-4', 'chat-a-3']);
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'scope-retention-trim', model: messages.modelId, count: 2 });
    reader.unmount();
  });
});

type TempRow = { id: string; createdAt: string; label: string };

const createTempRows = (id: string, maxAgeMs?: number, protectTempRows?: () => ReadonlySet<string>) =>
  defineModel({
    id,
    name: id,
    gc: 'exempt',
    fields: { createdAt: f.str(), label: f.str() },
    ...(maxAgeMs === undefined ? {} : { maintenance: { dropTempRowsAfterMs: maxAgeMs, ...(protectTempRows ? { protectTempRows } : {}) } })
  });

describe('unresolved temp row retention', () => {
  const old = () => new Date(Date.now() - 10_000).toISOString();
  const fresh = () => new Date().toISOString();

  it('drops an old unprotected temp row during GC', () => {
    setupSpecRuntime();
    const rows = createTempRows('PendingTtlOld', 1000);
    rows.insert({ id: 'temp-old', createdAt: old(), label: 'old' });
    act(() => {
      collectGarbage();
    });
    expect(rows.find('temp-old')).toBeUndefined();
  });

  it('keeps an old temp row while its mutation is pending', async () => {
    let resolve!: (value: { data: { save: TempRow } }) => void;
    const transport = createMockTransport({
      mutation: () =>
        new Promise(resolvePromise => {
          resolve = resolvePromise as never;
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createTempRows('PendingTtlPending', 1000);
    const save = rows.mutation<{ save: TempRow }, void, TempRow, TempRow>('save', {
      document,
      result: 'save',
      optimistic: { model: rows, build: () => ({ id: '', createdAt: old(), label: 'pending' }), selectServerNode: data => data.save }
    });
    const pending = save.run();
    act(() => {
      collectGarbage();
    });
    expect(rows.all()).toHaveLength(1);
    resolve({ data: { save: { id: 'server-1', createdAt: fresh(), label: 'done' } } });
    await pending;
  });

  it('keeps an aged failed temp row until its operation is discarded', async () => {
    const transport = createMockTransport({ mutation: async () => Promise.reject(new Error('offline')) });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createTempRows('PendingTtlFailed', 1000);
    const save = rows.mutation<{ save: TempRow }, void, TempRow, TempRow>('save', {
      document,
      result: 'save',
      optimistic: { model: rows, build: () => ({ id: '', createdAt: old(), label: 'failed' }), selectServerNode: data => data.save }
    });
    await expect(save.run()).rejects.toThrow('offline');

    collectGarbage();
    expect(rows.all()).toHaveLength(1);

    clearFailedOptimisticMutation(rows.modelId, rows.all()[0]!.id);
    collectGarbage();
    expect(rows.all()).toEqual([]);
  });

  it('keeps a fresh temp row', () => {
    setupSpecRuntime();
    const rows = createTempRows('PendingTtlFresh', 1000);
    rows.insert({ id: 'temp-fresh', createdAt: fresh(), label: 'fresh' });
    collectGarbage();
    expect(rows.find('temp-fresh')).toBeTruthy();
  });

  it('drops a temp row with an unparseable creation time', () => {
    setupSpecRuntime();
    const rows = createTempRows('PendingTtlInvalid', 1000);
    rows.insert({ id: 'temp-invalid', createdAt: 'invalid', label: 'invalid' });
    collectGarbage();
    expect(rows.find('temp-invalid')).toBeUndefined();
  });

  it('never drops a permanent id', () => {
    setupSpecRuntime();
    const rows = createTempRows('PendingTtlPermanent', 1000);
    rows.insert({ id: 'server-old', createdAt: old(), label: 'server' });
    collectGarbage();
    expect(rows.find('server-old')).toBeTruthy();
  });

  it('does not clean a model without a declared age', () => {
    setupSpecRuntime();
    const rows = createTempRows('PendingTtlDisabled');
    rows.insert({ id: 'temp-old', createdAt: old(), label: 'old' });
    collectGarbage();
    expect(rows.find('temp-old')).toBeTruthy();
  });

  it('removes without a tombstone so a later authoritative write lands', () => {
    setupSpecRuntime();
    const rows = createTempRows('PendingTtlNoTombstone', 1000);
    rows.insert({ id: 'temp-old', createdAt: old(), label: 'old' });
    collectGarbage();
    rows.insert({ id: 'temp-old', createdAt: fresh(), label: 'authoritative' });
    expect(rows.find('temp-old')?.label).toBe('authoritative');
  });

  it('notifies a mounted reader once for one cleanup batch', () => {
    setupSpecRuntime();
    const rows = createTempRows('PendingTtlRender', 1000);
    rows.insertMany([
      { id: 'temp-a', createdAt: old(), label: 'a' },
      { id: 'temp-b', createdAt: old(), label: 'b' }
    ]);
    const reader = renderCounted(() => rows.use.find('temp-a'));
    const before = reader.renders();
    act(() => {
      collectGarbage();
    });
    expect(reader.renders() - before).toBe(1);
    reader.unmount();
  });

  it('records the cleanup count in diagnostics', () => {
    setupSpecRuntime();
    const rows = createTempRows('PendingTtlDiagnostics', 1000);
    rows.insertMany([
      { id: 'temp-a', createdAt: old(), label: 'a' },
      { id: 'temp-b', createdAt: old(), label: 'b' }
    ]);
    collectGarbage();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'stale-temp-row-expiry', model: rows.modelId, count: 2 });
  });

  it('keeps an old row protected by the model source', () => {
    setupSpecRuntime();
    const protectedIds = new Set(['temp-model']);
    const rows = createTempRows('PendingTtlModelProtected', 1000, () => protectedIds);
    rows.insert({ id: 'temp-model', createdAt: old(), label: 'protected' });
    collectGarbage();
    expect(rows.find('temp-model')).toBeTruthy();
  });

  it('reads the model protection source again for the next cleanup', () => {
    setupSpecRuntime();
    const protectedIds = new Set(['temp-model']);
    const rows = createTempRows('PendingTtlModelLive', 1000, () => protectedIds);
    rows.insert({ id: 'temp-model', createdAt: old(), label: 'protected' });
    collectGarbage();
    protectedIds.clear();
    collectGarbage();
    expect(rows.find('temp-model')).toBeUndefined();
  });

  it('unions model and pending-operation protection', async () => {
    let resolve!: (value: { data: { save: TempRow } }) => void;
    const transport = createMockTransport({
      mutation: () =>
        new Promise(resolvePromise => {
          resolve = resolvePromise as never;
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const protectedIds = new Set(['temp-model']);
    const rows = createTempRows('PendingTtlProtectionUnion', 1000, () => protectedIds);
    rows.insert({ id: 'temp-model', createdAt: old(), label: 'model' });
    const save = rows.mutation<{ save: TempRow }, void, TempRow, TempRow>('save', {
      document,
      result: 'save',
      optimistic: { model: rows, build: () => ({ id: '', createdAt: old(), label: 'pending' }), selectServerNode: data => data.save }
    });
    const pending = save.run();
    collectGarbage();
    expect(rows.all()).toHaveLength(2);
    resolve({ data: { save: { id: 'server-1', createdAt: fresh(), label: 'done' } } });
    await pending;
  });

  it('applies model protection during boot and GC', async () => {
    setupSpecRuntime();
    const protectedIds = new Set(['temp-model']);
    const rows = createTempRows('PendingTtlBootAndGc', 1000, () => protectedIds);
    rows.insert({ id: 'temp-model', createdAt: old(), label: 'protected' });
    persistCurrentManifest();
    await bootDb();
    expect(rows.find('temp-model')).toBeTruthy();
    collectGarbage();
    expect(rows.find('temp-model')).toBeTruthy();
  });
});
