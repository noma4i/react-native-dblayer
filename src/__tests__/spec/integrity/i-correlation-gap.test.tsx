import { act } from 'react';
import { belongsTo, configureDb, defineModelRuntime, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

// Channel-agnostic temp correlation (G1, closed in 9.0): a mutation that declares
// `optimistic.correlate` gets its still-open temp rows collapsed into the matching server row no
// matter which channel delivers it - query result application, an unrelated mutation's extract
// sink, or a subscription/ingest handler. The correlation seam lives in `planRows`, the single
// point every write channel plans upsert rows through, and draws candidates from the durable
// operation ledger (open insert operations), so a false merge cannot come from a whole-model scan.

type MessageRow = { id: string; chatId: string; body: string; status: 'Sending' | 'Failed' | 'Sent' };
type ChatRow = { id: string; lastMessageId: string | null; lastActivityAt: number };

const document = { kind: 'Document', definitions: [] } as never;

const createMessagesModel = (suffix: string) =>
  defineModelRuntime({
    id: `SpecIntegrityCorrelationMessages${suffix}`,
    name: `SpecIntegrityCorrelationMessages${suffix}`,
    fields: {
      id: f.str(),
      chatId: f.str(),
      body: f.str(),
      status: f.enum<MessageRow['status']>(['Sending', 'Failed', 'Sent'])
    },
    maintenance: { dropTempRowsAfterMs: 60_000 },
    scopes: {
      thread: ({ by: { chatId: 'chatId' } })
    }
  });

const createSendMutation = (messages: ReturnType<typeof createMessagesModel>) =>
  messages.mutation<{ messageSend: { message: MessageRow } }, { chatId: string; body: string }, MessageRow, MessageRow>('send', {
    document,
    result: 'messageSend',
    optimistic: {
      model: messages,
      tempIdPrefix: 'msg',
      build: (input, { tempId }) => ({ id: tempId!, chatId: input.chatId, body: input.body, status: 'Sending' }),
      selectServerNode: data => data.messageSend.message,
      onFailurePatch: () => ({ status: 'Failed' }),
      correlate: { fields: ['chatId', 'body'] }
    }
  });

describe('channel-agnostic temp correlation', () => {
  it('case 1: a query-delivered server row collapses the still-pending temp row of the same logical message', async () => {
    const transport = createMockTransport({
      // The mutation response never arrives (lost/never processed) - mirrors the "response of own
      // mutation lost" scenario. The temp row is left permanently in 'Sending'.
      mutation: () => new Promise(() => {}),
      query: async <TData,>() => ({
        data: { thread: { nodes: [{ id: 'server-1', chatId: 'chat-1', body: 'hello', status: 'Sent' }], pageInfo: { hasPreviousPage: false } } } as TData
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const messages = createMessagesModel('Query');
    const send = createSendMutation(messages);
    // Mirrors yupi_v2's real chatThreadQuery shape (coverage: 'page', direction: 'backward'), not the
    // library's non-paginated default ('complete' coverage, which wholesale-replaces scope membership
    // on every fetch and would trivially "fix" this by accident).
    const query = messages.query<{ thread: { nodes: MessageRow[]; pageInfo: { hasPreviousPage: boolean } } }, { chatId: string }, { chatId: string }, MessageRow>('thread', {
      document,
      vars: value => value,
      page: data => ({ nodes: data.thread.nodes, pageInfo: data.thread.pageInfo }),
      into: messages.scopes.thread,
      coverage: 'page',
      direction: 'backward'
    });

    act(() => {
      void send.run({ chatId: 'chat-1', body: 'hello' });
    });
    expect(messages.scopes.thread.read({ chatId: 'chat-1' })).toHaveLength(1);

    // Direct, non-hook fetch (the same `query.fetch` a screen's mount effect would trigger) - avoids
    // pulling DbProvider/bootDb into this scenario, since bootDb runs its own crash-recovery pass
    // (unrelated to this defect) that would confound a still-genuinely-in-flight mutation.
    await act(async () => {
      await query.fetch({ chatId: 'chat-1' });
    });

    const rows = messages.scopes.thread.read({ chatId: 'chat-1' });
    // DESIRED: one logical message, one row (the server-confirmed one). ACTUAL today: two rows
    // (the still-pending temp row plus the query-delivered server row).
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('server-1');
  });

  it('case 2: an unrelated mutation extract sink collapses the still-pending temp row of the same logical message', async () => {
    const transport = createMockTransport({
      mutation: async <TData,>(operation: { variables?: unknown }) => {
        const variables = (operation.variables ?? {}) as { input?: { chatId?: string } };
        if (variables.input?.chatId) return new Promise<{ data: TData }>(() => {});
        return { data: { giftSend: { message: { id: 'server-1', chatId: 'chat-1', body: 'hello', status: 'Sent' } } } } as { data: TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const messages = createMessagesModel('Extract');
    const send = createSendMutation(messages);
    const giftEcho = messages.mutation<{ giftSend: { message: MessageRow } }, Record<string, never>, never, never>('giftEcho', {
      document,
      result: 'giftSend',
      mapInput: () => ({}),
      extract: ({ data }) => [{ into: messages, rows: [data.giftSend.message] }]
    });

    act(() => {
      void send.run({ chatId: 'chat-1', body: 'hello' });
    });
    expect(messages.scopes.thread.read({ chatId: 'chat-1' })).toHaveLength(1);

    await act(async () => {
      await giftEcho.run({});
    });

    const rows = messages.scopes.thread.read({ chatId: 'chat-1' });
    // DESIRED: one logical message, one row. ACTUAL today: two rows - the extract sink of a
    // completely unrelated mutation writes the server row by its own id with no correlation check.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('server-1');
  });

  it('case 3: a subscription/ingest handler collapses the still-pending temp row of the same logical message', async () => {
    const transport = createMockTransport({ mutation: () => new Promise(() => {}) });
    configureDb({ storage: createMemoryPlane(), transport });
    const messages = createMessagesModel('Ingest');
    const send = createSendMutation(messages);
    const ingest = messages.ingest({
      messageCreated: { handler: payload => ({ upsert: (payload as { message: MessageRow }).message }) }
    });

    act(() => {
      void send.run({ chatId: 'chat-1', body: 'hello' });
    });
    expect(messages.scopes.thread.read({ chatId: 'chat-1' })).toHaveLength(1);

    act(() => {
      ingest.apply('messageCreated', { message: { id: 'server-1', chatId: 'chat-1', body: 'hello', status: 'Sent' } });
    });

    const rows = messages.scopes.thread.read({ chatId: 'chat-1' });
    // DESIRED: one logical message, one row. ACTUAL today: two rows - the ingest handler upserts the
    // server row by its own id with no correlation to the temp row already sitting in the same scope.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('server-1');
  });

  it('case 4: a failed temp row resolves when the equivalent server row arrives through another channel', async () => {
    const transport = createMockTransport({
      mutation: async () => Promise.reject(new Error('offline')),
      query: async <TData,>() => ({
        data: { thread: { nodes: [{ id: 'server-1', chatId: 'chat-1', body: 'hello', status: 'Sent' }], pageInfo: { hasPreviousPage: false } } } as TData
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const messages = createMessagesModel('FailedLiveness');
    const send = createSendMutation(messages);
    const query = messages.query<{ thread: { nodes: MessageRow[]; pageInfo: { hasPreviousPage: boolean } } }, { chatId: string }, { chatId: string }, MessageRow>('thread', {
      document,
      vars: value => value,
      page: data => ({ nodes: data.thread.nodes, pageInfo: data.thread.pageInfo }),
      into: messages.scopes.thread,
      coverage: 'page',
      direction: 'backward'
    });

    let tempId!: string;
    await act(async () => {
      const runPromise = send.run({ chatId: 'chat-1', body: 'hello' });
      tempId = messages.scopes.thread.read({ chatId: 'chat-1' })[0]!.id;
      await expect(runPromise).rejects.toThrow('offline');
    });
    expect(messages.find(tempId)).toMatchObject({ status: 'Failed' });

    // The same logical message is now confirmed via a completely different channel (a thread
    // refetch), the way it would be in the app if the thread screen is reopened after the lost
    // response. Today nothing marks the failed row as resolved or removes it: it is orphaned
    // forever, coexisting with the server row that eventually arrives through any other channel.
    await act(async () => {
      await query.fetch({ chatId: 'chat-1' });
    });

    const rows = messages.scopes.thread.read({ chatId: 'chat-1' });
    // DESIRED: the failed row either resolves (collapses into the confirmed server row) or the
    // core explicitly flags it as still requiring resolution instead of silently going stale.
    // ACTUAL today: the failed row just sits there unresolved (`use.failed` stays true forever, and
    // `use.failed` itself is a hook so it is exercised through operation-state introspection instead)
    // and the confirmed server row is a second, independent row in the same scope.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('server-1');
  });

  it('case 6: closes the correlated pending operation as committed', async () => {
    const transport = createMockTransport({ mutation: () => new Promise(() => {}) });
    configureDb({ storage: createMemoryPlane(), transport });
    const messages = createMessagesModel('CloseOp');
    const send = createSendMutation(messages);
    const ingest = messages.ingest({
      messageCreated: { handler: payload => ({ upsert: (payload as { message: MessageRow }).message }) }
    });

    act(() => {
      void send.run({ chatId: 'chat-1', body: 'hello' });
    });
    const tempId = messages.scopes.thread.read({ chatId: 'chat-1' })[0]!.id;
    const pending = renderCounted(() => messages.use.pending(tempId));
    expect(pending.result()).toBe(true);

    act(() => {
      ingest.apply('messageCreated', { message: { id: 'server-1', chatId: 'chat-1', body: 'hello', status: 'Sent' } });
    });

    // The operation whose temp row was confirmed through another channel must not stay pending
    // forever - it closes as committed at correlation time.
    expect(pending.result()).toBe(false);
    pending.unmount();
  });

  // Case 5, as specified, cannot be reproduced through the public API: `deriveEffects`
  // (react-native-dblayer/src/core/relations.ts) gates the ENTIRE `upsertEffects` call - which is
  // what runs a `belongsTo` relation's `touch`/`counterCache` - behind `acceptedRow.origin === 'event'`
  // (see the loop over `accepted` right before the effect-flush loop). A mutation's own optimistic
  // insert writes with `origin: undefined` (plain `planRows`, no `{ origin: 'event' }` passed - see
  // `defineMutation.ts`'s `InsertOptimistic` branch), and even its own successful commit writes with
  // `origin: 'replace'` (`planReplace`) - NEITHER value satisfies the `'event'` gate. Only an
  // ingest/subscription-driven upsert (`defineIngest.ts` explicitly tags its ops `origin: 'event'`)
  // ever reaches `upsertEffects`. So a mutation's optimistic insert never touches its `belongsTo`
  // parent in the first place - there is nothing for a failed mutation to roll back, and no way to
  // construct the "optimistic insert touches parent, then the mutation fails" scenario through the
  // public API at all. The two assertions below verify this directly (mid-flight AND after a
  // successful commit) instead of guessing from the source comment alone.
  it('case 5: cannot be reproduced - a mutation optimistic insert never touches its belongsTo parent at all (only origin:"event" ingest applies do), so there is nothing to roll back on failure', async () => {
    const chats = defineModelRuntime({
      id: 'SpecIntegrityCorrelationChatsRollback',
      name: 'SpecIntegrityCorrelationChatsRollback',
      fields: { id: f.str(), lastMessageId: f.str().nullable(), lastActivityAt: f.num() }
    });
    const messages = defineModelRuntime({
      id: 'SpecIntegrityCorrelationMessagesRollback',
      name: 'SpecIntegrityCorrelationMessagesRollback',
      fields: { id: f.str(), chatId: f.str(), body: f.str(), status: f.enum<MessageRow['status']>(['Sending', 'Failed', 'Sent']) },
      maintenance: { dropTempRowsAfterMs: 1000 },
      relations: () => ({
        chat: belongsTo<MessageRow, ChatRow>(chats, {
          foreignKey: 'chatId',
          touch: message => ({ lastMessageId: message.id, lastActivityAt: 1 })
        })
      })
    });

    // Sub-case A: mutation fails - confirms there is no touch to roll back.
    const failingTransport = createMockTransport({ mutation: async () => Promise.reject(new Error('offline')) });
    configureDb({ storage: createMemoryPlane(), transport: failingTransport });
    chats.insert({ id: 'chat-1', lastMessageId: 'm-old', lastActivityAt: 0 });
    const failingSend = messages.mutation<{ messageSend: { message: MessageRow } }, { chatId: string; body: string }, MessageRow, MessageRow>('send', {
      document,
      result: 'messageSend',
      optimistic: {
        model: messages,
        tempIdPrefix: 'msg',
        build: (input, { tempId }) => ({ id: tempId!, chatId: input.chatId, body: input.body, status: 'Sending' }),
        selectServerNode: data => data.messageSend.message,
        onFailurePatch: () => ({ status: 'Failed' })
      }
    });
    const runPromise = failingSend.run({ chatId: 'chat-1', body: 'hello' });
    // Mid-flight, right after the optimistic insert, BEFORE the mutation has even had a chance to
    // fail: the parent is already untouched.
    expect(chats.find('chat-1')).toMatchObject({ lastMessageId: 'm-old' });
    await expect(runPromise).rejects.toThrow('offline');
    expect(chats.find('chat-1')).toMatchObject({ lastMessageId: 'm-old' });

    // Sub-case B: mutation SUCCEEDS (server confirms, planReplace commits with origin:'replace') -
    // still no touch. This rules out "maybe touch only fires on commit, not on the optimistic phase".
    const succeedingTransport = createMockTransport({
      mutation: async <TData,>() => ({ data: { messageSend: { message: { id: 'server-1', chatId: 'chat-1', body: 'hello', status: 'Sent' } } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport: succeedingTransport });
    chats.insert({ id: 'chat-1', lastMessageId: 'm-old', lastActivityAt: 0 });
    const succeedingSend = messages.mutation<{ messageSend: { message: MessageRow } }, { chatId: string; body: string }, MessageRow, MessageRow>('send2', {
      document,
      result: 'messageSend',
      optimistic: {
        model: messages,
        tempIdPrefix: 'msg',
        build: (input, { tempId }) => ({ id: tempId!, chatId: input.chatId, body: input.body, status: 'Sending' }),
        selectServerNode: data => data.messageSend.message
      }
    });
    await succeedingSend.run({ chatId: 'chat-1', body: 'hello' });
    expect(chats.find('chat-1')).toMatchObject({ lastMessageId: 'm-old' });
  });
});
