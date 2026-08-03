import { belongsTo, defineModel, defineShape, f } from '../../testApi';
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
  const chats = defineModel(`SpecCounterFilter${suffix}Chats`, {
    schema: defineShape<Chat>()({ unreadCount: f.num() })
  });
  const messages = defineModel(`SpecCounterFilter${suffix}Messages`, {
    schema: defineShape<Message>()({ chatId: f.str(), unread: f.bool(), body: f.str() }),
    associations: () => ({
      chat: belongsTo<Message, Chat>(chats, {
        foreignKey: 'chatId',
        counterCache: { field: 'unreadCount', filter: (message: Message) => message.unread }
      })
    })
  });
  chats.insert({ id: 'chat-1', unreadCount: 0 });
  return { chats, messages };
};

describe('filtered counter cache', () => {
  it('counts a child the filter admits', () => {
    const { chats, messages } = createModels('Admits');

    messages.insert({ id: 'm-1', chatId: 'chat-1', unread: true, body: 'hello' });

    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1 });
  });

  it('ignores a child the filter rejects', () => {
    const { chats, messages } = createModels('Rejects');

    messages.insert({ id: 'm-1', chatId: 'chat-1', unread: false, body: 'hello' });

    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 0 });
  });

  it('decrements only for the children it counted', () => {
    const { chats, messages } = createModels('Symmetry');
    messages.insertMany([
      { id: 'm-counted', chatId: 'chat-1', unread: true, body: 'counted' },
      { id: 'm-ignored', chatId: 'chat-1', unread: false, body: 'ignored' }
    ]);
    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1 });

    // Removing the child that never counted must not move the counter.
    messages.destroy('m-ignored');
    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1 });

    messages.destroy('m-counted');
    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 0 });
  });

  it('counts a re-delivered child once, however many times it arrives', () => {
    const { chats, messages } = createModels('Redelivery');
    const row = { id: 'm-1', chatId: 'chat-1', unread: true, body: 'hello' };

    messages.insert(row);
    // A re-delivery that also CHANGES content is still an update of the same child, not a new one.
    messages.insert({ ...row, body: 'edited' });
    messages.insert({ ...row, body: 'edited again' });

    // Only the FIRST arrival creates the child; a re-delivery of the same id is the same message.
    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1 });
  });

  it('leaves the counter untouched when an existing child changes its filter answer', () => {
    const { chats, messages } = createModels('Patch');
    messages.insert({ id: 'm-1', chatId: 'chat-1', unread: true, body: 'hello' });
    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1 });

    // Effects model the EXISTENCE of a child, not its contents: a patch carries no counter effect,
    // so a parent snapshot owns the correction.
    messages.update('m-1', { unread: false });

    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1 });
  });
});
