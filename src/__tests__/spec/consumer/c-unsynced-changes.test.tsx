import { act } from 'react-test-renderer';
import { configureDb, defineModel, f } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

// use.unsyncedChanges: pending optimistic patch values, cleared on commit/failure.

type ChatRow = { id: string; pinned: boolean; title: string };

const document = { kind: 'Document', definitions: [] } as never;

const setup = (suffix: string) => {
  const mutations: Array<{ resolve: (data: unknown) => void; reject: (error: unknown) => void }> = [];
  const transport = createMockTransport({
    mutation: async <TData,>() =>
      await new Promise<{ data: TData }>((resolve, reject) => {
        mutations.push({ resolve: data => resolve({ data: data as TData }), reject });
      })
  });
  configureDb({ storage: createMemoryPlane(), transport });
  const chats = defineModel({
    id: `SpecUnsyncedChanges${suffix}`,
    name: `SpecUnsyncedChanges${suffix}`,
    fields: { id: f.str(), pinned: f.bool(), title: f.str() }
  });
  const pinChat = chats.mutation<{ pinChat: ChatRow }, { id: string }, ChatRow, ChatRow>('pin-chat', {
    document,
    result: 'pinChat',
    dedupe: false,
    optimistic: { method: 'patch', model: chats, selectId: input => input.id, selectPatch: () => ({ pinned: true }) },
    extract: ({ data }) => [{ into: chats, rows: [data.pinChat] }]
  });
  return { chats, pinChat, mutations };
};

describe('use.unsyncedChanges', () => {
  it('exposes pending optimistic patch values and clears on commit', async () => {
    const { chats, pinChat, mutations } = setup('Commit');
    chats.insertStored({ id: 'chat-1', pinned: false, title: 'General' });
    const reader = renderCounted(() => chats.use.unsyncedChanges('chat-1'));
    expect(reader.result()).toBeUndefined();
    let run!: Promise<unknown>;
    act(() => {
      run = pinChat.run({ id: 'chat-1' });
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
    const { chats, pinChat, mutations } = setup('Failure');
    chats.insertStored({ id: 'chat-1', pinned: false, title: 'General' });
    const reader = renderCounted(() => chats.use.unsyncedChanges('chat-1'));
    let run!: Promise<unknown>;
    act(() => {
      run = pinChat.run({ id: 'chat-1' });
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
    chats.insertStored({ id: 'chat-1', pinned: false, title: 'General' });
    const reader = renderCounted(() => chats.use.unsyncedChanges(null));
    expect(reader.result()).toBeUndefined();
    reader.unmount();
  });
});
