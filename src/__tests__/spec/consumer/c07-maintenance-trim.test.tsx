import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { act } from 'react';
import {
  bootDb,
  computeSchemaFingerprints,
  configureDb,
  DB_FORMAT_VERSION,
  defineModel,
  defineModelRuntime,
  defineShape,
  f,
  runPendingTempRowMaintenance,
  writePersistenceManifest
} from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics, renderCounted, setupSpecRuntime, settle } from '../helpers/harness';

type MessageRow = { id: string; chatId: string; sequence: number; payload: string };
type MessageResponse = { rows: MessageRow[] };

const document = { kind: 'Document', definitions: [] } as never;
const persistCurrentManifest = () => writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });

const createMessageModel = (limit: number, protect?: () => Set<string>) =>
  defineModelRuntime({
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
    const messages = defineModelRuntime({
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
type SaveData = { save: TempRow };
type SaveVariables = { input: Record<string, never> };

const TempRowSchema = defineShape<TempRow>()({ createdAt: f.str(), label: f.str() });
const saveDocument: TypedDocumentNode<SaveData, SaveVariables> = { kind: Kind.DOCUMENT, definitions: [] };

const createTempRows = (id: string, maxAgeMs?: number, protectTempRows?: () => ReadonlySet<string>) =>
  defineModelRuntime({
    id,
    name: id,
    
    fields: { createdAt: f.str(), label: f.str() },
    ...(maxAgeMs === undefined ? {} : { maintenance: { dropTempRowsAfterMs: maxAgeMs, ...(protectTempRows ? { protectTempRows } : {}) } })
  });

const createActionTempRows = (key: string, protectTempRows?: () => ReadonlySet<string>) =>
  defineModel(key, {
    schema: TempRowSchema,
    maintenance: { dropTempRowsAfterMs: 1000, ...(protectTempRows ? { protectTempRows } : {}) },
    actions: owner => ({
      save: owner.gql.action(saveDocument, {
        mode: 'request',
        result: 'save',
        variables: () => ({ input: {} }),
        optimistic: {
          root: { insert: { select: ({ tempId }) => ({ id: tempId, createdAt: new Date(Date.now() - 10_000).toISOString(), label: 'pending' }) } }
        },
        root: { insert: { select: ({ data }) => data.save } }
      })
    })
  });

describe('unresolved temp row retention', () => {
  const old = () => new Date(Date.now() - 10_000).toISOString();
  const fresh = () => new Date().toISOString();

  it('drops an old unprotected temp row during GC', () => {
    setupSpecRuntime();
    const rows = createTempRows('PendingTtlOld', 1000);
    rows.insert({ id: 'temp-old', createdAt: old(), label: 'old' });
    act(() => {
      runPendingTempRowMaintenance();
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
    const rows = createActionTempRows('PendingTtlPending');
    const pending = rows.actions.save.run({});
    act(() => {
      runPendingTempRowMaintenance();
    });
    expect(rows.where({}).read()).toHaveLength(1);
    resolve({ data: { save: { id: 'server-1', createdAt: fresh(), label: 'done' } } });
    await pending;
  });

  it('keeps an aged failed temp row until its operation is discarded', async () => {
    const transport = createMockTransport({ mutation: async () => Promise.reject(new Error('offline')) });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createActionTempRows('PendingTtlFailed');
    await expect(rows.actions.save.run({})).rejects.toThrow('offline');

    runPendingTempRowMaintenance();
    expect(rows.where({}).read()).toHaveLength(1);

    rows.actions.save.discard(rows.where({}).read()[0]!.id);
    runPendingTempRowMaintenance();
    expect(rows.where({}).read()).toEqual([]);
  });

  it('keeps a fresh temp row', () => {
    setupSpecRuntime();
    const rows = createTempRows('PendingTtlFresh', 1000);
    rows.insert({ id: 'temp-fresh', createdAt: fresh(), label: 'fresh' });
    runPendingTempRowMaintenance();
    expect(rows.find('temp-fresh')).toBeTruthy();
  });

  it('drops a temp row with an unparseable creation time', () => {
    setupSpecRuntime();
    const rows = createTempRows('PendingTtlInvalid', 1000);
    rows.insert({ id: 'temp-invalid', createdAt: 'invalid', label: 'invalid' });
    runPendingTempRowMaintenance();
    expect(rows.find('temp-invalid')).toBeUndefined();
  });

  it('never drops a permanent id', () => {
    setupSpecRuntime();
    const rows = createTempRows('PendingTtlPermanent', 1000);
    rows.insert({ id: 'server-old', createdAt: old(), label: 'server' });
    runPendingTempRowMaintenance();
    expect(rows.find('server-old')).toBeTruthy();
  });

  it('does not clean a model without a declared age', () => {
    setupSpecRuntime();
    const rows = createTempRows('PendingTtlDisabled');
    rows.insert({ id: 'temp-old', createdAt: old(), label: 'old' });
    runPendingTempRowMaintenance();
    expect(rows.find('temp-old')).toBeTruthy();
  });

  it('removes without a tombstone so a later authoritative write lands', () => {
    setupSpecRuntime();
    const rows = createTempRows('PendingTtlNoTombstone', 1000);
    rows.insert({ id: 'temp-old', createdAt: old(), label: 'old' });
    runPendingTempRowMaintenance();
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
      runPendingTempRowMaintenance();
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
    runPendingTempRowMaintenance();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'stale-temp-row-expiry', model: rows.modelId, count: 2 });
  });

  it('keeps an old row protected by the model source', () => {
    setupSpecRuntime();
    const protectedIds = new Set(['temp-model']);
    const rows = createTempRows('PendingTtlModelProtected', 1000, () => protectedIds);
    rows.insert({ id: 'temp-model', createdAt: old(), label: 'protected' });
    runPendingTempRowMaintenance();
    expect(rows.find('temp-model')).toBeTruthy();
  });

  it('reads the model protection source again for the next cleanup', () => {
    setupSpecRuntime();
    const protectedIds = new Set(['temp-model']);
    const rows = createTempRows('PendingTtlModelLive', 1000, () => protectedIds);
    rows.insert({ id: 'temp-model', createdAt: old(), label: 'protected' });
    runPendingTempRowMaintenance();
    protectedIds.clear();
    runPendingTempRowMaintenance();
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
    const rows = createActionTempRows('PendingTtlProtectionUnion', () => protectedIds);
    rows.insert({ id: 'temp-model', createdAt: old(), label: 'model' });
    const pending = rows.actions.save.run({});
    runPendingTempRowMaintenance();
    expect(rows.where({}).read()).toHaveLength(2);
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
    runPendingTempRowMaintenance();
    expect(rows.find('temp-model')).toBeTruthy();
  });
});
