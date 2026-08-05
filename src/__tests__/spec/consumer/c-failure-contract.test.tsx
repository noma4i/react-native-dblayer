import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { belongsTo, configureDb, createCommitEnvelope, defineModel, defineShape, f, getApplyRuntime, MutationDeliveryUnknownError, resetRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

type Row = { id: string; label: string; status: 'pending' | 'done' };
type Input = { label: string };
type Variables = { input: Input };
type Data = { createRow: { row: Row } };

const RowSchema = defineShape<Row>()({
  label: f.str(),
  status: f.enum(['pending', 'done'] as const)
});
const document: TypedDocumentNode<Data, Variables> = { kind: Kind.DOCUMENT, definitions: [] };

const defineRows = (key: string) =>
  defineModel(key, {
    schema: RowSchema,
    maintenance: { dropTempRowsAfterMs: 60_000 },
    actions: owner => ({
      create: owner.gql.action(document, {
        mode: 'request',
        result: 'createRow',
        variables: (input: Input) => ({ input }),
        optimistic: {
          root: {
            insert: {
              select: ({ input, tempId }) => ({ id: tempId, label: input.label, status: 'pending' as const })
            }
          }
        },
        root: { insert: { select: ({ data }) => data.createRow.row } }
      })
    })
  });

afterEach(resetRuntime);

describe('action failure contract', () => {
  it('rejects GraphQL errors even when the response also contains data', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        mutation: async <TData,>() => ({
            data: { createRow: { row: { id: 'server-1', label: 'server', status: 'done' } } } as TData,
            errors: [{ message: 'rejected' }]
          })
      })
    });
    const rows = defineRows('SpecActionFailureGraphqlError');

    await expect(rows.actions.create.run({ label: 'local' })).rejects.toThrow('rejected');

    expect(rows.find('server-1')).toBeUndefined();
    expect(rows.operation(rows.where({}).read()[0]?.id).read()).toMatchObject({ failed: true });
  });

  it('accepts an empty GraphQL error array', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        mutation: async <TData,>() => ({
            data: { createRow: { row: { id: 'server-1', label: 'server', status: 'done' } } } as TData,
            errors: []
          })
      })
    });
    const rows = defineRows('SpecActionFailureEmptyErrors');

    await rows.actions.create.run({ label: 'local' });

    expect(rows.where({}).read()).toEqual([{ id: 'server-1', label: 'server', status: 'done' }]);
  });

  it('keeps an optimistic request when mutation delivery is unknown', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        mutation: async () => {
          throw new MutationDeliveryUnknownError('response was not observed');
        }
      })
    });
    const rows = defineRows('SpecActionFailureDeliveryUnknown');

    await expect(rows.actions.create.run({ label: 'local' })).rejects.toThrow('response was not observed');

    const optimistic = rows.where({}).read()[0]!;
    expect(optimistic).toMatchObject({ label: 'local', status: 'pending' });
    expect(rows.operation(optimistic.id).read()).toMatchObject({
      pending: false,
      failed: false,
      deliveryUnknown: true
    });
    await expect(rows.actions.create.retry(optimistic.id)).resolves.toBeNull();
  });

  it('[RE2] leaves no partial derived state when a plan with relation effects is refused', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const chats = defineModel('SpecFailureEffectChats', {
      schema: defineShape<{ id: string; unreadCount: number; lastActivityAt: number }>()({ unreadCount: f.num(), lastActivityAt: f.num() })
    });
    const messages = defineModel('SpecFailureEffectMessages', {
      schema: defineShape<{ id: string; chatId: string; createdAt: number }>()({ chatId: f.str(), createdAt: f.num() }),
      associations: () => ({
        chat: belongsTo<{ id: string; chatId: string; createdAt: number }, { id: string; unreadCount: number; lastActivityAt: number }>(chats, {
          foreignKey: 'chatId',
          counterCache: { field: 'unreadCount' },
          touch: (message, chat) => (message.createdAt > chat.lastActivityAt ? { lastActivityAt: message.createdAt } : null)
        })
      })
    });
    chats.insert({ id: 'chat-1', unreadCount: 0, lastActivityAt: 0 });

    // The child upsert would derive a counter bump and a parent touch, but the malformed
    // sibling op refuses the WHOLE plan: no child row, original counter, original touch mark.
    expect(() =>
      getApplyRuntime().commit(
        createCommitEnvelope([
          { kind: 'upsert', model: messages.key, rows: [{ id: 'msg-1', chatId: 'chat-1', createdAt: 5 }], origin: 'event' },
          { kind: 'upsert', model: messages.key, rows: [{ chatId: 'chat-1', createdAt: 6 }], origin: 'event' }
        ])
      )
    ).toThrow();

    expect(messages.find('msg-1')).toBeUndefined();
    expect(chats.find('chat-1')).toEqual({ id: 'chat-1', unreadCount: 0, lastActivityAt: 0 });
  });

  it('rejects an optimistic insert model without temp-row retention', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });

    expect(() =>
      defineModel('SpecActionFailureMissingRetention', {
        schema: RowSchema,
        actions: owner => ({
          create: owner.gql.action(document, {
            mode: 'request',
            result: 'createRow',
            variables: (input: Input) => ({ input }),
            optimistic: {
              root: {
                insert: {
                  select: ({ input, tempId }) => ({ id: tempId, label: input.label, status: 'pending' as const })
                }
              }
            },
            root: { insert: { select: ({ data }) => data.createRow.row } }
          })
        })
      })
    ).toThrow('dropTempRowsAfterMs');
  });
});
