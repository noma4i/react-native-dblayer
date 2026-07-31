import { act } from 'react';
import { configureDb, defineModelRuntime, f, getOperationState } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

const QUERY_DOCUMENT = { kind: 'Document', definitions: [] } as never;
const SUBSCRIPTION_DOCUMENT = { kind: 'Document', definitions: [] } as never;

type MessageRow = { id: string; chatId: string; clientId: string | null; seq: number; text: string };
type ThreadResponse = { rows: MessageRow[] };
type SendResponse = { send: { row: MessageRow } };

/**
 * A live push and an optimistic mutation describe the same logical send. Whatever order the
 * network delivers them in, a mounted reader must see exactly one row for that send, the ledger
 * must not keep an open operation for a temp row that no longer exists, and a pushed row must
 * take its declared place in a sorted window immediately.
 */
const createHarness = (
  suffix: string,
  mutationHandler: () => Promise<{ data: SendResponse }>,
  coverage: 'page' | 'complete' = 'page'
) => {
  const pushHandlers: Array<{ next: (data: unknown) => void; error: (error: unknown) => void }> = [];
  const transport = createMockTransport({
    query: async <TData,>() => ({ data: { rows: [] } as TData }),
    mutation: <TData,>() => mutationHandler() as Promise<{ data: TData }>,
    subscribe: (_options, handlers) => {
      pushHandlers.push(handlers);
      return jest.fn();
    }
  });
  configureDb({ storage: createMemoryPlane(), transport });
  const messages = defineModelRuntime({
    id: `SpecLiveOverOptimistic${suffix}`,
    name: `SpecLiveOverOptimistic${suffix}`,
    fields: { chatId: f.str(), clientId: f.str().nullable(), seq: f.num(), text: f.str() },
    maintenance: { dropTempRowsAfterMs: 60_000 },
    scopes: {
      thread: ({
        by: { chatId: 'chatId' },
        sort: { comparator: (left: MessageRow, right: MessageRow) => right.seq - left.seq }
      })
    }
  });
  const threadQuery = messages.query<ThreadResponse, { chatId: string }, { chatId: string }, MessageRow>('thread', {
    document: QUERY_DOCUMENT,
    vars: scopeValue => ({ chatId: scopeValue.chatId }),
    select: data => data.rows,
    into: messages.scopes.thread,
    coverage,
    staleTime: Infinity,
    live: {
      messageAdded: { document: SUBSCRIPTION_DOCUMENT, apply: 'upsert' }
    }
  });
  let capturedTempId = '';
  const send = messages.mutation('send', {
    document: QUERY_DOCUMENT,
    result: 'send',
    optimistic: {
      model: messages,
      build: (input: { chatId: string; clientId: string; seq: number; text: string }, context: { tempId: string | null }) => {
        capturedTempId = context.tempId!;
        return { id: capturedTempId, chatId: input.chatId, clientId: input.clientId, seq: input.seq, text: input.text };
      },
      selectServerNode: (data: SendResponse) => data.send.row,
      correlate: { fields: ['clientId'] }
    }
  });
  return { messages, threadQuery, send, pushHandlers, tempId: () => capturedTempId };
};

const openInsertCount = (modelId: string): number => getOperationState().openInsertsFor(modelId).length;

describe('live push over an optimistic send', () => {
  it('replaces the pending optimistic row with the pushed echo and stays single after the mutation resolves', async () => {
    let resolveMutation!: (value: { data: SendResponse }) => void;
    const harness = createHarness('EchoPending', () => new Promise(resolve => {
      resolveMutation = resolve;
    }));
    const reader = renderCounted(() => harness.threadQuery.use({ chatId: 'chat-1' }));
    let runPromise!: Promise<unknown>;
    act(() => {
      runPromise = harness.send.run({ chatId: 'chat-1', clientId: 'client-1', seq: 1, text: 'optimistic' });
    });
    expect((reader.result().data as MessageRow[]).map(row => row.id)).toEqual([harness.tempId()]);

    act(() => harness.pushHandlers[0]!.next({ messageAdded: { id: 'srv-1', chatId: 'chat-1', clientId: 'client-1', seq: 1, text: 'echoed' } }));

    expect((reader.result().data as MessageRow[]).map(row => row.id)).toEqual(['srv-1']);
    expect(harness.messages.find(harness.tempId())).toBeUndefined();
    expect(openInsertCount(harness.messages.modelId)).toBe(0);

    await act(async () => {
      resolveMutation({ data: { send: { row: { id: 'srv-1', chatId: 'chat-1', clientId: 'client-1', seq: 1, text: 'committed' } } } });
      await runPromise;
    });

    const rows = reader.result().data as MessageRow[];
    expect(rows.map(row => row.id)).toEqual(['srv-1']);
    expect(rows[0]!.text).toBe('committed');
    expect(openInsertCount(harness.messages.modelId)).toBe(0);
    reader.unmount();
  });

  it('replaces a failed optimistic row with the pushed echo and closes its failed operation', async () => {
    const harness = createHarness('EchoFailed', () => Promise.reject(new Error('send failed')));
    const reader = renderCounted(() => harness.threadQuery.use({ chatId: 'chat-1' }));
    await act(async () => {
      await expect(harness.send.run({ chatId: 'chat-1', clientId: 'client-9', seq: 5, text: 'will fail' })).rejects.toThrow('send failed');
    });
    // The failed row must survive AND stay on screen: failure keeps the send visible for retry.
    expect(harness.messages.find(harness.tempId())).toMatchObject({ text: 'will fail' });
    expect((reader.result().data as MessageRow[]).map(row => row.id)).toEqual([harness.tempId()]);
    expect(openInsertCount(harness.messages.modelId)).toBe(1);

    act(() => harness.pushHandlers[0]!.next({ messageAdded: { id: 'srv-9', chatId: 'chat-1', clientId: 'client-9', seq: 5, text: 'delivered after all' } }));

    expect((reader.result().data as MessageRow[]).map(row => row.id)).toEqual(['srv-9']);
    expect(harness.messages.find(harness.tempId())).toBeUndefined();
    expect(openInsertCount(harness.messages.modelId)).toBe(0);
    reader.unmount();
  });

  it('slots a pushed row into its comparator position of a sorted window immediately', () => {
    const harness = createHarness('SortedSlot', () => Promise.reject(new Error('unused')));
    const reader = renderCounted(() => harness.threadQuery.use({ chatId: 'chat-1' }));

    act(() => harness.pushHandlers[0]!.next({ messageAdded: { id: 'm-3', chatId: 'chat-1', clientId: null, seq: 3, text: 'newest' } }));
    act(() => harness.pushHandlers[0]!.next({ messageAdded: { id: 'm-1', chatId: 'chat-1', clientId: null, seq: 1, text: 'oldest' } }));
    act(() => harness.pushHandlers[0]!.next({ messageAdded: { id: 'm-2', chatId: 'chat-1', clientId: null, seq: 2, text: 'middle' } }));

    expect((reader.result().data as MessageRow[]).map(row => row.id)).toEqual(['m-3', 'm-2', 'm-1']);
    reader.unmount();
  });

  it('keeps a row held by an open operation on screen when a complete server snapshot lands without it', async () => {
    let resolveMutation!: (value: { data: SendResponse }) => void;
    const harness = createHarness(
      'CompleteVsPending',
      () => new Promise(resolve => {
        resolveMutation = resolve;
      }),
      'complete'
    );
    const reader = renderCounted(() => harness.threadQuery.use({ chatId: 'chat-1' }));
    let runPromise!: Promise<unknown>;
    act(() => {
      runPromise = harness.send.run({ chatId: 'chat-1', clientId: 'client-5', seq: 1, text: 'just sent' });
    });
    expect((reader.result().data as MessageRow[]).map(row => row.id)).toEqual([harness.tempId()]);

    // The initial fetch resolves now with an empty complete snapshot. The server cannot know about
    // an unconfirmed send, so the snapshot must not evict the row its open operation holds.
    await act(async () => {
      await Promise.resolve();
    });

    expect(harness.messages.find(harness.tempId())).toMatchObject({ text: 'just sent' });
    expect((reader.result().data as MessageRow[]).map(row => row.id)).toEqual([harness.tempId()]);

    await act(async () => {
      resolveMutation({ data: { send: { row: { id: 'srv-5', chatId: 'chat-1', clientId: 'client-5', seq: 1, text: 'confirmed' } } } });
      await runPromise;
    });
    expect((reader.result().data as MessageRow[]).map(row => row.id)).toEqual(['srv-5']);
    reader.unmount();
  });

  it('keeps a row held by an open operation inside a retention-trimmed scope', async () => {
    const pushHandlers: Array<{ next: (data: unknown) => void; error: (error: unknown) => void }> = [];
    const transport = createMockTransport({
      query: async <TData,>() => ({
        data: { rows: [
          { id: 'srv-a', chatId: 'chat-1', clientId: null, seq: 10, text: 'newest' },
          { id: 'srv-b', chatId: 'chat-1', clientId: null, seq: 9, text: 'older' }
        ] } as TData
      }),
      mutation: <TData,>() => new Promise<{ data: TData }>(() => {}),
      subscribe: (_options, handlers) => {
        pushHandlers.push(handlers);
        return jest.fn();
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const messages = defineModelRuntime({
      id: 'SpecLiveOverOptimisticTrim',
      name: 'SpecLiveOverOptimisticTrim',
      fields: { chatId: f.str(), clientId: f.str().nullable(), seq: f.num(), text: f.str() },
      maintenance: { dropTempRowsAfterMs: 60_000 },
      scopes: {
        thread: ({
          by: { chatId: 'chatId' },
          sort: { comparator: (left: MessageRow, right: MessageRow) => right.seq - left.seq },
          retention: { maxRows: 2 }
        })
      }
    });
    const threadQuery = messages.query<ThreadResponse, { chatId: string }, { chatId: string }, MessageRow>('trim', {
      document: QUERY_DOCUMENT,
      vars: scopeValue => ({ chatId: scopeValue.chatId }),
      select: data => data.rows,
      into: messages.scopes.thread,
      coverage: 'complete',
      staleTime: Infinity
    });
    let capturedTempId = '';
    const send = messages.mutation('send', {
      document: QUERY_DOCUMENT,
      result: 'send',
      optimistic: {
        model: messages,
        build: (input: { seq: number }, context: { tempId: string | null }) => {
          capturedTempId = context.tempId!;
          return { id: capturedTempId, chatId: 'chat-1', clientId: 'client-t', seq: input.seq, text: 'mine' };
        },
        selectServerNode: (data: SendResponse) => data.send.row
      }
    });
    const reader = renderCounted(() => threadQuery.use({ chatId: 'chat-1' }));
    // My send is the oldest by comparator, so a naive maxRows=2 trim of the 3-row snapshot cuts it.
    act(() => {
      void send.run({ seq: 1 });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(messages.find(capturedTempId)).toBeDefined();
    expect((reader.result().data as MessageRow[]).map(row => row.id)).toContain(capturedTempId);
    reader.unmount();
  });
});
