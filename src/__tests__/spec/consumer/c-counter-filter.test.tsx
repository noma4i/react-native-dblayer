import { belongsTo, defineModelRuntime, f } from '../../testApi';
import { setupSpecRuntime } from '../helpers/harness';

type Chat = { id: string; unreadCount: number };
type Message = { id: string; chatId: string; unread: boolean; body: string };

/**
 * A filtered counter cache counts only the children the filter admits, and the write and rollback
 * paths apply the SAME filter. An asymmetric filter drifts the counter permanently: every child
 * that counted on arrival but not on removal leaves the parent one too high, forever.
 */
const createModels = (suffix: string) => {
  setupSpecRuntime();
  const chats = defineModelRuntime({
    id: `SpecCounterFilter${suffix}Chats`,
    name: `SpecCounterFilter${suffix}Chats`,
    fields: { unreadCount: f.num() }
  });
  const messages = defineModelRuntime({
    id: `SpecCounterFilter${suffix}Messages`,
    name: `SpecCounterFilter${suffix}Messages`,
    fields: { chatId: f.str(), unread: f.bool(), body: f.str() },
    relations: () => ({
      chat: belongsTo<Message, Chat>(chats, {
        foreignKey: 'chatId',
        counterCache: { field: 'unreadCount', filter: (message: Message) => message.unread }
      })
    })
  });
  chats.insert({ id: 'chat-1', unreadCount: 0 });
  const ingest = messages.ingest({
    arrive: { handler: payload => ({ upsert: (payload as { rows: Message[] }).rows }) },
    remove: { handler: payload => ({ destroy: (payload as { id: string }).id }) },
    arriveAndRemove: { handler: payload => ({ upsert: (payload as { row: Message }).row, destroy: (payload as { row: Message }).row.id }) }
  });
  return { chats, messages, ingest };
};

describe('filtered counter cache', () => {
  it('counts a child the filter admits', () => {
    const { chats, ingest } = createModels('Admits');

    ingest.apply('arrive', { rows: [{ id: 'm-1', chatId: 'chat-1', unread: true, body: 'hello' }] });

    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1 });
  });

  it('ignores a child the filter rejects', () => {
    const { chats, ingest } = createModels('Rejects');

    ingest.apply('arrive', { rows: [{ id: 'm-1', chatId: 'chat-1', unread: false, body: 'hello' }] });

    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 0 });
  });

  it('decrements only for the children it counted', () => {
    const { chats, ingest } = createModels('Symmetry');
    ingest.apply('arrive', {
      rows: [
        { id: 'm-counted', chatId: 'chat-1', unread: true, body: 'counted' },
        { id: 'm-ignored', chatId: 'chat-1', unread: false, body: 'ignored' }
      ]
    });
    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1 });

    // Removing the child that never counted must not move the counter.
    ingest.apply('remove', { id: 'm-ignored' });
    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1 });

    ingest.apply('remove', { id: 'm-counted' });
    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 0 });
  });

  it('counts a re-delivered child once, however many times it arrives', () => {
    const { chats, ingest } = createModels('Redelivery');
    const row = { id: 'm-1', chatId: 'chat-1', unread: true, body: 'hello' };

    ingest.apply('arrive', { rows: [row] });
    // A re-delivery that also CHANGES content is still an update of the same child, not a new one.
    ingest.apply('arrive', { rows: [{ ...row, body: 'edited' }] });
    ingest.apply('arrive', { rows: [{ ...row, body: 'edited again' }] });

    // Only the FIRST arrival creates the child; a re-delivery of the same id is the same message.
    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1 });
  });

  it('nets a filtered child born and destroyed in one batch to zero', () => {
    const { chats, ingest } = createModels('NetZero');

    ingest.apply('arriveAndRemove', { row: { id: 'm-1', chatId: 'chat-1', unread: true, body: 'hello' } });

    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 0 });
  });

  it('leaves the counter untouched when an existing child changes its filter answer', () => {
    const { chats, messages, ingest } = createModels('Patch');
    ingest.apply('arrive', { rows: [{ id: 'm-1', chatId: 'chat-1', unread: true, body: 'hello' }] });
    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1 });

    // Effects model the EXISTENCE of a child, not its contents: a patch carries no counter effect,
    // so a parent snapshot owns the correction.
    messages.update('m-1', { unread: false });

    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1 });
  });
});
