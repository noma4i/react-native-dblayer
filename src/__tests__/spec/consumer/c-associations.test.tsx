import { act } from 'react';
import { belongsTo, configureDb, defineModel, defineShape, f, hasMany, hasOne, modelRef, references } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type UserInput = {
  id: string;
  username: string;
};

type ChatInput = {
  id: string;
  ownerId: string;
  memberIds: string[];
};

type MessageInput = {
  id: string;
  chatId: string;
  authorId: string;
  sequence: number;
};

const UserSchema = defineShape<UserInput>()({
  username: f.str()
});

const MessageSchema = defineShape<MessageInput>()({
  chatId: f.id(),
  authorId: f.id(),
  sequence: f.num()
});

const ChatSchema = defineShape<ChatInput>()({
  ownerId: f.id(),
  memberIds: f.array(f.id())
});

describe('associations', () => {
  it('resolves lazy targets across a cyclic model graph', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const Chat = defineModel('SpecLazyAssociationChat', {
      schema: ChatSchema,
      associations: () => ({
        messages: hasMany<ChatInput, MessageInput>(modelRef<MessageInput>('SpecLazyAssociationMessage'), { foreignKey: 'chatId' })
      })
    });
    const Message = defineModel('SpecLazyAssociationMessage', {
      schema: MessageSchema,
      associations: () => ({
        chat: belongsTo<MessageInput, ChatInput>(modelRef<ChatInput>('SpecLazyAssociationChat'), { foreignKey: 'chatId' }),
        replies: references<MessageInput, MessageInput>(modelRef<MessageInput>('SpecLazyAssociationMessage'), { ids: message => message.id })
      })
    });

    Chat.insert({ id: 'chat-1', ownerId: 'user-1', memberIds: [] });
    Message.insert({ id: 'message-1', chatId: 'chat-1', authorId: 'user-1', sequence: 1 });

    expect(Chat.messages('chat-1').read().map(row => row.id)).toEqual(['message-1']);
    expect(Message.chat('message-1').read()?.id).toBe('chat-1');
    expect(Message.replies('message-1').read().map(row => row.id)).toEqual(['message-1']);
  });

  it('exposes every association kind as a flat Relation method', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const User = defineModel('SpecAssociationUser', {
      schema: UserSchema
    });
    const Message = defineModel('SpecAssociationMessage', {
      schema: MessageSchema,
      associations: () => ({
        author: belongsTo<MessageInput, UserInput>(User, { foreignKey: 'authorId' })
      })
    });
    const Chat = defineModel('SpecAssociationChat', {
      schema: ChatSchema,
      associations: () => ({
        messages: hasMany<ChatInput, MessageInput>(Message, { foreignKey: 'chatId' }),
        latest: hasOne<ChatInput, MessageInput>(Message, {
          foreignKey: 'chatId',
          comparator: (left, right) => right.sequence - left.sequence
        }),
        members: references<ChatInput, UserInput>(User, { ids: chat => chat.memberIds })
      })
    });
    User.insertMany([
      { id: 'user-1', username: 'one' },
      { id: 'user-2', username: 'two' }
    ]);
    Chat.insert({ id: 'chat-1', ownerId: 'user-1', memberIds: ['user-1', 'user-2'] });
    Message.insert({ id: 'message-1', chatId: 'chat-1', authorId: 'user-1', sequence: 1 });

    expect(Message.author('message-1').read()).toEqual({ id: 'user-1', username: 'one' });
    expect(Chat.messages('chat-1').read()).toEqual([{ id: 'message-1', chatId: 'chat-1', authorId: 'user-1', sequence: 1 }]);
    expect(Chat.latest('chat-1').read()).toEqual({ id: 'message-1', chatId: 'chat-1', authorId: 'user-1', sequence: 1 });
    expect(Chat.members('chat-1').read()).toEqual([
      { id: 'user-1', username: 'one' },
      { id: 'user-2', username: 'two' }
    ]);
    expect(Message.author('message-1').count()).toBe(1);
    expect(Message.author('missing').count()).toBe(0);
    expect(Chat.messages('chat-1').count()).toBe(1);
    expect(Chat.members('chat-1').count()).toBe(2);
    expect(Message.author).toBe(Message.author);
    expect(Reflect.get(Message, Symbol.toStringTag)).toBeUndefined();
    expect(Reflect.get(Message, 'missingAssociation')).toBeUndefined();
    Message.author('message-1').invalidate();
    await Message.author('message-1').fetch();
    await Message.author('message-1').refresh();
    expect(() => Message.author('message-1').seed([])).toThrow('seed requires a model relation');
    expect(() => Message.author('message-1').issueSequence('username')).toThrow('requires a named relation');

    const messages = renderCounted(() => Chat.messages('chat-1').use());
    const latest = renderCounted(() => Chat.latest('chat-1').use());
    const author = renderCounted(() => Message.author('message-1').use());
    const members = renderCounted(() => Chat.members('chat-1').use());
    const authorCount = renderCounted(() => Message.author('message-1').useCount());
    try {
      act(() => {
        Message.insert({ id: 'message-2', chatId: 'chat-1', authorId: 'user-2', sequence: 2 });
        User.update('user-1', { username: 'updated' });
        Chat.update('chat-1', { memberIds: ['user-2'] });
      });
      expect(messages.result().data.map(row => row.id)).toEqual(['message-1', 'message-2']);
      expect(latest.result().data?.id).toBe('message-2');
      expect(author.result().data?.username).toBe('updated');
      author.result().loadMore();
      expect(members.result().data.map(row => row.id)).toEqual(['user-2']);
      expect(authorCount.result()).toBe(1);
    } finally {
      messages.unmount();
      latest.unmount();
      author.unmount();
      members.unmount();
      authorCount.unmount();
    }
  });

  it('rejects association names that collide with the model surface', () => {
    const User = defineModel('SpecAssociationCollisionUser', {
      schema: UserSchema
    });
    const Message = defineModel('SpecAssociationCollisionMessage', {
      schema: MessageSchema,
      associations: () => ({
        find: belongsTo<MessageInput, UserInput>(User, { foreignKey: 'authorId' })
      })
    });

    expect(() => Message.find).toThrow('association find collides with the model surface');
  });

  it('rejects statics that collide with the model surface', () => {
    expect(() =>
      defineModel('SpecStaticCollisionUser', {
        schema: UserSchema,
        statics: () => ({ find: () => undefined })
      })
    ).toThrow('static find collides with the model surface');
  });

  it('resolves every lazy target read and rejects an unregistered target', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const User = defineModel('SpecLazyTargetReads', {
      schema: UserSchema
    });
    User.insertMany([
      { id: 'user-1', username: 'one' },
      { id: 'user-2', username: 'two' }
    ]);
    const target = modelRef<UserInput>('SpecLazyTargetReads');

    expect(target.all().map(row => row.id)).toEqual(['user-1', 'user-2']);
    expect(target.where({ username: 'two' }).map(row => row.id)).toEqual(['user-2']);
    expect(() => modelRef<UserInput>('SpecMissingLazyTarget').find('user-1')).toThrow('No model registered for SpecMissingLazyTarget');
  });
});
