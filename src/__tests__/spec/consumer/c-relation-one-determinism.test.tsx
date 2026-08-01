import { act } from 'react';
import { defineModelRuntime, f, hasOne } from '../../testApi';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

type LatestReader = { use: { related(id: string, relation: string): unknown } };

type ChatRow = { id: string; inboxId: string };
type MessageRow = { id: string; chatId: string; rank: number; text: string };

/**
 * A `hasOne` relation names ONE row, so every read surface must name the same one. A consumer
 * comparator that reports a tie decides nothing; the canonical id tie-break decides, which makes
 * the choice independent of the order rows happen to arrive in. A surface that reduces over a raw
 * comparator picks whatever arrived first and contradicts the other surfaces.
 */
const createModels = (suffix: string) => {
  setupSpecRuntime();
  const messages = defineModelRuntime({
    id: `SpecRelationOne${suffix}Messages`,
    name: `SpecRelationOne${suffix}Messages`,
    fields: { chatId: f.str(), rank: f.num(), text: f.str() }
  });
  const chats = defineModelRuntime({
    id: `SpecRelationOne${suffix}Chats`,
    name: `SpecRelationOne${suffix}Chats`,
    fields: { inboxId: f.str() },
    scopes: { inbox: ({ by: { inboxId: 'inboxId' } }) },
    relations: () => ({
      latest: hasOne<ChatRow, MessageRow>(messages, {
        foreignKey: 'chatId',
        // Ranks tie deliberately: the comparator abstains and the tie-break must decide.
        comparator: (left, right) => right.rank - left.rank
      })
    })
  });
  chats.insert({ id: 'chat-1', inboxId: 'main' });
  return { messages, chats };
};

const mountLatest = (chats: unknown) => renderCounted(() => (chats as LatestReader).use.related('chat-1', 'latest') as MessageRow | undefined);

describe('hasOne resolves to one row on every surface', () => {
  it('picks the id tie-break winner whatever order tied rows arrived in', () => {
    const { messages, chats } = createModels('Arrival');
    // 'm-b' arrives FIRST: a raw reduce would keep it, the tie-break must not.
    messages.insert({ id: 'm-b', chatId: 'chat-1', rank: 5, text: 'arrived first' });
    messages.insert({ id: 'm-a', chatId: 'chat-1', rank: 5, text: 'arrived second' });

    const reader = mountLatest(chats);

    expect(reader.result()?.id).toBe('m-a');
    reader.unmount();
  });

  it('names the same row to a reader that mounted before the rows and one that mounted after', () => {
    const { messages, chats } = createModels('Agree');
    const early = mountLatest(chats);
    act(() => {
      messages.insert({ id: 'm-b', chatId: 'chat-1', rank: 5, text: 'arrived first' });
      messages.insert({ id: 'm-a', chatId: 'chat-1', rank: 5, text: 'arrived second' });
    });

    const late = mountLatest(chats);

    expect(early.result()?.id).toBe('m-a');
    expect(late.result()?.id).toBe('m-a');
    early.unmount();
    late.unmount();
  });

  it('keeps the tie-break winner after a tied row leaves and re-enters the relation', () => {
    const { messages, chats } = createModels('Reenter');
    messages.insert({ id: 'm-a', chatId: 'chat-1', rank: 5, text: 'first arrival' });
    messages.insert({ id: 'm-b', chatId: 'chat-1', rank: 5, text: 'second arrival' });
    const reader = mountLatest(chats);
    expect(reader.result()?.id).toBe('m-a');

    // The winner leaves and comes back, so it is now the LAST arrival: order must not decide a tie.
    act(() => messages.update('m-a', { chatId: 'chat-other' }));
    act(() => messages.update('m-a', { chatId: 'chat-1' }));

    const late = mountLatest(chats);
    expect(reader.result()?.id).toBe('m-a');
    expect(late.result()?.id).toBe('m-a');
    late.unmount();
    reader.unmount();
  });

  it('still honors a comparator that does not tie', () => {
    const { messages, chats } = createModels('Ordered');
    messages.insert({ id: 'm-a', chatId: 'chat-1', rank: 1, text: 'older' });
    messages.insert({ id: 'm-b', chatId: 'chat-1', rank: 9, text: 'newest' });

    const reader = mountLatest(chats);

    expect(reader.result()?.id).toBe('m-b');
    reader.unmount();
  });
});
