import { act } from 'react-test-renderer';
import { bootDb, defineModel, f, scope } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

type MessageRow = { id: string; chatId: string; sequence: number; payload: string };
type MessageScope = MessageRow;

const settle = async () => {
  for (let tick = 0; tick < 6; tick += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

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
      byChat: scope<MessageScope>({
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

    for (let sequence = 1; sequence <= 5; sequence += 1) {
      messages.insertStored({ id: `chat-a-${sequence}`, chatId: 'chat-a', sequence, payload: `row-${sequence}` });
    }
    for (let sequence = 1; sequence <= 2; sequence += 1) {
      messages.insertStored({ id: `chat-b-${sequence}`, chatId: 'chat-b', sequence, payload: `other-${sequence}` });
    }

    await bootDb();

    expect(messages.scopes.byChat.read({ chatId: 'chat-a' }).map(row => row.sequence)).toEqual([5, 4, 3]);
    expect(messages.scopes.byChat.read({ chatId: 'chat-b' })).toHaveLength(2);
  });

  it('keeps protected ids in scope even when they are older than the limit', async () => {
    setupSpecRuntime();
    const protectIds = new Set(['chat-a-protected']);
    const messages = createMessageModel(2, () => protectIds);

    messages.insertStored({ id: 'chat-a-protected', chatId: 'chat-a', sequence: 1, payload: 'protected-old' });
    messages.insertStored({ id: 'chat-a-2', chatId: 'chat-a', sequence: 2, payload: 'new-2' });
    messages.insertStored({ id: 'chat-a-3', chatId: 'chat-a', sequence: 3, payload: 'new-3' });
    messages.insertStored({ id: 'chat-a-4', chatId: 'chat-a', sequence: 4, payload: 'new-4' });

    await bootDb();

    expect(messages.scopes.byChat.read({ chatId: 'chat-a' }).map(row => row.id)).toEqual(['chat-a-4', 'chat-a-3', 'chat-a-protected']);
  });

  it.failing('rerenders a mounted scope reader exactly once for a trim batch', async () => {
    // GAP: runtime currently keeps only one row for a scope trim batch when limit is 2.
    setupSpecRuntime();
    const messages = createMessageModel(2);
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      messages.insertStored({ id: `chat-a-${sequence}`, chatId: 'chat-a', sequence, payload: `row-${sequence}` });
    }

    const scopeReader = renderCounted(() => messages.scopes.byChat.use({ chatId: 'chat-a' }));
    const before = scopeReader.renders();
    await bootDb();
    await settle();

    expect(scopeReader.renders() - before).toBe(1);
    expect(scopeReader.result().map(row => row.id)).toEqual(['chat-a-4', 'chat-a-3']);
    scopeReader.unmount();
  });
});
