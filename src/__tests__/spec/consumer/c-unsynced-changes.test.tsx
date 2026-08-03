import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { act } from 'react';
import { configureDb, defineModel, defineShape, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

// use.unsyncedChanges: pending optimistic patch values, cleared on commit/failure.

type ChatRow = { id: string; pinned: boolean; title: string };
type PinInput = { id: string };
type PinResponse = { pinChat: ChatRow };
type PinVariables = { input: PinInput };

const pinDocument: TypedDocumentNode<PinResponse, PinVariables> = { kind: Kind.DOCUMENT, definitions: [] };

const setup = (suffix: string) => {
  const mutations: Array<{ resolve: (data: unknown) => void; reject: (error: unknown) => void }> = [];
  const transport = createMockTransport({
    mutation: async <TData,>() =>
      await new Promise<{ data: TData }>((resolve, reject) => {
        mutations.push({ resolve: data => resolve({ data: data as TData }), reject });
      })
  });
  configureDb({ storage: createMemoryPlane(), transport });
  const ChatSchema = defineShape<ChatRow>()({
    pinned: f.bool(),
    title: f.str()
  });
  const chats = defineModel(`SpecUnsyncedChanges${suffix}`, {
    schema: ChatSchema,
    actions: owner => ({
      pin: owner.gql.action(pinDocument, {
        mode: 'request',
        result: 'pinChat',
        variables: (input: PinInput) => ({ input }),
        optimistic: {
          root: {
            update: {
              select: ({ input }) => ({ id: input.id, patch: { pinned: true } })
            }
          }
        },
        root: {
          update: {
            select: ({ data }) => ({
              id: data.pinChat.id,
              patch: { pinned: data.pinChat.pinned, title: data.pinChat.title }
            })
          }
        }
      })
    })
  });
  return { chats, pin: chats.actions.pin, mutations };
};

describe('use.unsyncedChanges', () => {
  it('exposes pending optimistic patch values and clears on commit', async () => {
    const { chats, pin, mutations } = setup('Commit');
    chats.insert({ id: 'chat-1', pinned: false, title: 'General' });
    const reader = renderCounted(() => chats.operation('chat-1').use().unsyncedChanges);
    expect(reader.result()).toBeUndefined();
    let run!: Promise<unknown>;
    act(() => {
      run = pin.run({ id: 'chat-1' });
    });
    expect(reader.result()).toEqual({ pinned: true });
    await act(async () => {
      mutations[0]!.resolve({ pinChat: { id: 'chat-1', pinned: true, title: 'General' } });
      await run;
    });
    expect(reader.result()).toBeUndefined();
    reader.unmount();
  });

  it('clears when the operation fails', async () => {
    const { chats, pin, mutations } = setup('Failure');
    chats.insert({ id: 'chat-1', pinned: false, title: 'General' });
    const reader = renderCounted(() => chats.operation('chat-1').use().unsyncedChanges);
    let run!: Promise<unknown>;
    act(() => {
      run = pin.run({ id: 'chat-1' });
    });
    expect(reader.result()).toEqual({ pinned: true });
    await act(async () => {
      mutations[0]!.reject(new Error('offline'));
      await run.catch(() => undefined);
    });
    expect(reader.result()).toBeUndefined();
    reader.unmount();
  });

  it('returns undefined for nullish ids without subscribing', () => {
    const { chats } = setup('Nullish');
    chats.insert({ id: 'chat-1', pinned: false, title: 'General' });
    const reader = renderCounted(() => chats.operation(null).use().unsyncedChanges);
    expect(reader.result()).toBeUndefined();
    reader.unmount();
  });
});
