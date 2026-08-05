import { bootDb, configureDb, defineModel, defineShape, f, getApplyRuntime, readQuarantineEntries, resetRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

const document = { kind: 'Document', definitions: [] } as never;

type RowInput = {
  id: string;
  chatId: string;
  userId: string;
  body: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  sequenceNumber: number | null;
};

type SendData = { send: { message: RowInput } };

const RowSchema = defineShape<RowInput>()({
  chatId: f.str(),
  userId: f.str(),
  body: f.str(),
  status: f.str(),
  createdAt: f.str(),
  updatedAt: f.str(),
  sequenceNumber: f.num().nullable()
});

const Message = defineModel('SessionSwitchSamePlaneMessage', {
  schema: RowSchema,
  relations: () => ({
    thread: { by: { chatId: 'chatId' }, sort: { field: 'sequenceNumber', dir: 'desc' } }
  }),
  maintenance: { dropTempRowsAfterMs: 600_000 },
  actions: owner => ({
    send: owner.gql.action<SendData, Record<string, never>, { row: RowInput }, 'send'>(document, {
      mode: 'request',
      result: 'send',
      variables: () => ({}),
      optimistic: { root: { insert: { select: ({ input, tempId }) => ({ ...input.row, id: tempId }) } } },
      root: { insert: { select: ({ data }) => data.send.message } }
    })
  })
});

const NOW = '2026-08-06T00:00:00Z';

const serverRow = (id: string, chatId: string, sequenceNumber: number): RowInput => ({
  id,
  chatId,
  userId: 'other',
  body: `landed-${id}`,
  status: 'Sent',
  createdAt: NOW,
  updatedAt: NOW,
  sequenceNumber
});

/**
 * The session-switch lifecycle on ONE storage plane, with a real boot and no manual reseeding:
 * session A boots on an empty disk and accumulates rows, an open outbox operation and a quarantine
 * ticket; logout resets the runtime; session B keeps writing in the SAME process; a cold reboot of
 * the SAME plane then serves exactly B. Manifest continuity makes the reboot classify nothing as
 * corruption, and A's rows, operations and quarantine are gone per the user-reset rule - loudly,
 * through the declared discard event, never silently.
 */
describe('session switch on the same storage plane', () => {
  it('[P51] serves only session B after logout, same-process writes and a cold reboot of the same plane', async () => {
    const storage = createMemoryPlane();
    const hangingTransport = () =>
      createMockTransport({ mutation: async <TData,>() => new Promise<{ data: TData }>(() => {}) });
    configureDb({ storage, transport: hangingTransport() });
    await bootDb();

    // Session A: landed rows, one open outbox operation, one quarantine ticket.
    Message.where({ chatId: 'chat-a' }).seed([serverRow('a-1', 'chat-a', 1), serverRow('a-2', 'chat-a', 2)]);
    const invalid = { chatId: 'chat-a', userId: 'other', body: 'row without id', status: 'Sent', createdAt: NOW, updatedAt: NOW, sequenceNumber: 3 };
    Message.where({ chatId: 'chat-a' }).seed([invalid as never]);
    expect(readQuarantineEntries().filter(entry => entry.reason === 'plan-row-rejected')).toHaveLength(1);
    const draft: RowInput = { id: 'local-a', chatId: 'chat-a', userId: 'me', body: 'draft-a', status: 'Sending', createdAt: NOW, updatedAt: NOW, sequenceNumber: 100 };
    Message.actions.send.run({ row: draft }).catch(() => {});
    await Promise.resolve();
    const tempA = Message.where({ chatId: 'chat-a' }).read().find(row => row.status === 'Sending')!.id;
    expect(Message.operation(tempA).read().pending).toBe(true);
    getApplyRuntime().flushCacheSnapshots();

    // Logout: the wipe is sanctioned, the outbox discard is DECLARED, the quarantine goes with it.
    resetRuntime();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'user-reset-discard', model: '__operations__', count: 1 });
    expect(readQuarantineEntries()).toEqual([]);

    // Session B writes in the SAME process on the SAME plane - the store must stay manifested.
    Message.where({ chatId: 'chat-b' }).seed([serverRow('b-1', 'chat-b', 1)]);
    getApplyRuntime().flushCacheSnapshots();
    expect(storage.snapshotKeys()).toContain('dbl:manifest');

    // Cold reboot of the SAME plane: a fresh in-memory runtime hydrates from the disk B left.
    configureDb({ storage, transport: hangingTransport() });
    diagnostics().reset();
    await bootDb();

    expect(diagnostics().snapshot().dataLossEvents.filter(event => event.mechanism === 'model-corruption-recovery')).toEqual([]);
    expect(diagnostics().snapshot().manifestResets).toBe(0);
    // B's rows are alive, through the row plane and through the thread scope.
    expect(Message.find('b-1')).toMatchObject({ body: 'landed-b-1' });
    expect(Message.thread({ chatId: 'chat-b' }).read().map(row => row.id)).toEqual(['b-1']);
    // A's rows, operation and quarantine are gone per the user-reset rule.
    expect(Message.find('a-1')).toBeUndefined();
    expect(Message.find('a-2')).toBeUndefined();
    expect(Message.find(tempA)).toBeUndefined();
    expect(Message.thread({ chatId: 'chat-a' }).read()).toEqual([]);
    expect(Message.operation(tempA).read()).toMatchObject({ pending: false, failed: false });
    expect(readQuarantineEntries()).toEqual([]);
  });
});
