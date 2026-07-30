import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { configureDb, defineCommand, defineModel, defineShape, f, gql, intoIf } from '../../../index';
import { createMemoryPlane, createMockTransport, diagnostics, renderCountedInProvider, settleUntil } from '../helpers/harness';

type UserInput = {
  id: string;
  username: string;
};

type ChatInput = {
  id: string;
  ownerId: string;
  title: string;
};

type ChatPayload = ChatInput & {
  owner: UserInput;
};

type ChatsData = {
  chats: {
    nodes: ChatPayload[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type ChatsVariables = {
  ownerId: string;
};

type CreateChatData = {
  createChat: {
    chat: ChatPayload;
  };
};

type CreateChatVariables = {
  input: {
    ownerId: string;
    title: string;
  };
};

const chatsDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<ChatsData, ChatsVariables>;
const createChatDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<CreateChatData, CreateChatVariables>;
const refreshUserDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<
  { refreshUser: { user: UserInput } },
  { input: { id: string } }
>;

const UserSchema = defineShape<UserInput>()({
  username: f.str()
});

const ChatSchema = defineShape<ChatInput>()({
  ownerId: f.id(),
  title: f.str()
});

const createGraphModels = (suffix: string) => {
  const User = defineModel(`SpecGraphUser${suffix}`, {
    schema: UserSchema
  });
  const Chat = defineModel(`SpecGraphChat${suffix}`, {
    schema: ChatSchema,
    relations: {
      byOwner: {
        by: { ownerId: 'ownerId' },
        remote: gql.connection(chatsDocument, {
          variables: (params: { ownerId: string }) => ({ ownerId: params.ownerId }),
          connection: data => data.chats
        })
      }
    },
    actions: {
      create: gql.action(createChatDocument, {
        result: 'createChat',
        variables: input => ({ input }),
        kind: 'insert',
        select: data => data.createChat.chat,
        optimistic: {
          build: (input, context) => ({
            id: context.tempId,
            ownerId: input.ownerId,
            title: input.title
          })
        }
      })
    },
    sideloads: () => ({
      owner: {
        model: User,
        select: input => (isChatPayload(input) ? input.owner : null)
      },
      duplicateOwner: {
        model: User,
        select: input => (isChatPayload(input) ? input.owner : null)
      }
    }),
    maintenance: { dropTempRowsAfterMs: 1000 }
  });
  return { Chat, User };
};

describe('sideload graph', () => {
  it('normalizes, deduplicates, and commits a direct graph in one envelope', () => {
    configureRuntime(createMockTransport());
    diagnostics().reset();
    const { Chat, User } = createGraphModels('Direct');
    const payload: ChatPayload = {
      id: 'chat-1',
      ownerId: 'user-1',
      title: 'First',
      owner: { id: 'user-1', username: 'owner' }
    };

    Chat.insert(payload);

    expect(Chat.find('chat-1')).toEqual({ id: 'chat-1', ownerId: 'user-1', title: 'First' });
    expect(User.find('user-1')).toEqual({ id: 'user-1', username: 'owner' });
    expect(User.where({ id: 'user-1' }).count()).toBe(1);
    expect(diagnostics().snapshot().commits).toBe(1);
  });

  it('aborts the whole direct graph when a sideload row cannot normalize', () => {
    configureRuntime(createMockTransport());
    diagnostics().reset();
    const { Chat, User } = createGraphModels('Abort');
    const payload = {
      id: 'chat-invalid',
      ownerId: 'missing',
      title: 'Invalid',
      owner: { username: 'missing-id' }
    };

    expect(() => Chat.insert(payload)).toThrow('requires id');
    expect(Chat.find('chat-invalid')).toBeUndefined();
    expect(User.where({ username: 'missing-id' }).count()).toBe(0);
    expect(diagnostics().snapshot().commits).toBe(0);
  });

  it('terminates a cyclic graph and lands each model id once', () => {
    configureRuntime(createMockTransport());
    diagnostics().reset();
    const key = 'SpecGraphCategoryCycle';
    const Category = defineModel(key, {
      schema: defineShape<{ id: string; name: string }>()({
        name: f.str()
      }),
      sideloads: () => ({
        parent: {
          model: { key },
          select: input => (isCategoryPayload(input) ? input.parent : null)
        }
      })
    });
    const root: CategoryPayload = { id: 'category-1', name: 'Root', parent: null };
    const child: CategoryPayload = { id: 'category-2', name: 'Child', parent: root };
    root.parent = child;

    Category.insert(root);

    expect(Category.where({}).count()).toBe(2);
    expect(Category.find('category-1')).toEqual({ id: 'category-1', name: 'Root' });
    expect(Category.find('category-2')).toEqual({ id: 'category-2', name: 'Child' });
    expect(diagnostics().snapshot().commits).toBe(1);
  });

  it('uses the same graph for relation and action responses', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({
        data: {
          chats: {
            nodes: [
              {
                id: 'chat-query',
                ownerId: 'user-query',
                title: 'From query',
                owner: { id: 'user-query', username: 'query-owner' }
              }
            ],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        } as TData
      }),
      mutation: async <TData,>() => ({
        data: {
          createChat: {
            chat: {
              id: 'chat-action',
              ownerId: 'user-action',
              title: 'From action',
              owner: { id: 'user-action', username: 'action-owner' }
            }
          }
        } as TData
      })
    });
    configureRuntime(transport);
    diagnostics().reset();
    const { Chat, User } = createGraphModels('Remote');
    const reader = renderCountedInProvider(() => Chat.byOwner({ ownerId: 'user-query' }).use());

    await settleUntil(() => reader.result() !== undefined && reader.result().loadingState.isReady);
    expect(Chat.find('chat-query')).toEqual({ id: 'chat-query', ownerId: 'user-query', title: 'From query' });
    expect(User.find('user-query')).toEqual({ id: 'user-query', username: 'query-owner' });
    expect(diagnostics().snapshot().commits).toBe(1);

    await Chat.actions.create.run({ ownerId: 'user-action', title: 'From action' });
    expect(Chat.find('chat-action')).toEqual({ id: 'chat-action', ownerId: 'user-action', title: 'From action' });
    expect(User.find('user-action')).toEqual({ id: 'user-action', username: 'action-owner' });
    expect(diagnostics().snapshot().commits).toBe(3);
    reader.unmount();
  });

  it('lands cross-model command extracts through public model facades', async () => {
    const transport = createMockTransport({
      mutation: async <TData,>() => ({
        data: {
          refreshUser: {
            user: { id: 'user-command', username: 'command-owner' }
          }
        } as TData
      })
    });
    configureRuntime(transport);
    const { User } = createGraphModels('Command');
    const refreshUser = defineCommand<{ refreshUser: { user: UserInput } }, { id: string }>('refreshUser', {
      document: refreshUserDocument,
      result: 'refreshUser',
      mapInput: input => ({ input }),
      extract: ({ data }) => intoIf(User, data.refreshUser.user)
    });

    await refreshUser.run({ id: 'user-command' });

    expect(User.find('user-command')).toEqual({ id: 'user-command', username: 'command-owner' });
  });
});

const isChatPayload = (input: unknown): input is ChatPayload =>
  typeof input === 'object' && input !== null && 'owner' in input;

type CategoryPayload = {
  id: string;
  name: string;
  parent: CategoryPayload | null;
};

const isCategoryPayload = (input: unknown): input is CategoryPayload =>
  typeof input === 'object' && input !== null && 'parent' in input;

const configureRuntime = (transport: ReturnType<typeof createMockTransport>): void => {
  configureDb({ storage: createMemoryPlane(), transport });
};
