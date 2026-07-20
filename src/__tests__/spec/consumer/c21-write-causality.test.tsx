import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { DbProvider, configureDb, defineModel, f, scope } from '../../../index';
import { createMemoryPlane, createMockTransport, recordTimeline } from '../helpers/harness';

type ChatRow = { id: string; groupId: string; pinned: boolean; muted: boolean; read: boolean; rev: number };
type ScopeValue = { groupId: string };
type QueryResponse = { chats: ChatRow[] };
type PinResponse = { pinChat: ChatRow };
type MuteResponse = { muteChat: ChatRow };
type Deferred<T> = { resolve: (data: T) => void; reject: (error: Error) => void };

const document = { kind: 'Document', definitions: [] } as never;

const settle = async () => {
  for (let tick = 0; tick < 6; tick += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
};

const createFixture = (suffix: string, guarded = false) => {
  const queries: Deferred<QueryResponse>[] = [];
  const mutations: Deferred<PinResponse | MuteResponse>[] = [];
  const transport = createMockTransport({
    query: async <TData,>() =>
      await new Promise<{ data: TData }>((resolve, reject) => {
        queries.push({ resolve: data => resolve({ data: data as TData }), reject });
      }),
    mutation: async <TData,>() =>
      await new Promise<{ data: TData }>((resolve, reject) => {
        mutations.push({ resolve: data => resolve({ data: data as TData }), reject });
      })
  });
  configureDb({ storage: createMemoryPlane(), transport });
  const chats = defineModel({
    id: `SpecWriteCausality${suffix}`,
    name: `SpecWriteCausality${suffix}`,
    fields: {
      id: f.str(),
      groupId: f.str(),
      pinned: f.bool(),
      muted: f.bool(),
      read: f.bool(),
      rev: f.num()
    },
    mergePolicy: guarded
      ? {
          groups: [
            {
              fields: ['pinned', 'muted', 'rev'] as const,
              allowWrite: (incoming, current) => (incoming.rev ?? -1) >= current.rev
            }
          ]
        }
      : undefined,
    scopes: {
      byGroup: scope<ChatRow>({ by: { groupId: 'groupId' } })
    }
  });
  const query = chats.query<QueryResponse, ScopeValue, ScopeValue, ChatRow>('chats', {
    document,
    vars: value => value,
    select: data => data.chats,
    into: chats.scopes.byGroup
  });
  const pinChat = chats.mutation<PinResponse, { id: string }, ChatRow, ChatRow>('pin-chat', {
    document,
    result: 'pinChat',
    dedupe: false,
    optimistic: { method: 'patch', model: chats, selectId: input => input.id, selectPatch: () => ({ pinned: true }) },
    extract: ({ data }) => [{ into: chats, rows: [data.pinChat] }]
  });
  const muteChat = chats.mutation<MuteResponse, { id: string }, ChatRow, ChatRow>('mute-chat', {
    document,
    result: 'muteChat',
    dedupe: false,
    optimistic: { method: 'patch', model: chats, selectId: input => input.id, selectPatch: () => ({ muted: true }) },
    extract: ({ data }) => [{ into: chats, rows: [data.muteChat] }]
  });
  return { chats, query, pinChat, muteChat, queries, mutations };
};

const renderInProvider = <T,>(useHook: () => T) => {
  let value!: T;
  let root!: TestRenderer.ReactTestRenderer;

  const Reader = () => {
    value = useHook();
    return null;
  };

  act(() => {
    root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
  });

  return { result: () => value, unmount: () => act(() => root.unmount()) };
};

const initialRow: ChatRow = { id: 'chat-1', groupId: 'g', pinned: false, muted: false, read: false, rev: 10 };

describe('optimistic write causality', () => {
  it('W15 keeps a pending optimistic pin through a stale query snapshot', async () => {
    const { chats, query, pinChat, queries, mutations } = createFixture('W15');
    const frames = recordTimeline(() => chats.scopes.byGroup.use({ groupId: 'g' })[0]?.pinned);
    const queryReader = renderInProvider(() => query.use({ groupId: 'g' }));

    await settle();
    queries.shift()?.resolve({ chats: [initialRow] });
    await settle();
    let pin!: Promise<PinResponse | null>;
    act(() => {
      pin = pinChat.run({ id: 'chat-1' });
    });
    const frameStart = frames.frames().length;
    expect(frames.last()).toBe(true);

    act(() => {
      queryReader.result().refetch();
    });
    await settle();
    queries.shift()?.resolve({ chats: [initialRow] });
    await settle();

    const pendingFrames = frames.frames().slice(frameStart);
    mutations.shift()?.resolve({ pinChat: { ...initialRow, pinned: true } });
    await act(async () => {
      await pin;
    });

    expect(pendingFrames).not.toContain(false);
    frames.unmount();
    queryReader.unmount();
  });

  it('commits its own authoritative extract after releasing the optimistic patch overlay', async () => {
    const { chats, pinChat, mutations } = createFixture('OwnExtract');
    chats.insertStored(initialRow);
    const reader = recordTimeline(() => chats.use.row('chat-1'));
    let pin!: Promise<PinResponse | null>;

    act(() => {
      pin = pinChat.run({ id: 'chat-1' });
    });
    expect(reader.last()?.pinned).toBe(true);

    mutations.shift()?.resolve({ pinChat: { ...initialRow, pinned: false } });
    await act(async () => {
      await pin;
    });

    expect(reader.last()?.pinned).toBe(false);
    reader.unmount();
  });

  it('W17 preserves a later pending mute when an earlier pin rolls back', async () => {
    const { chats, pinChat, muteChat, mutations } = createFixture('W17');
    chats.insertStored(initialRow);
    const frames = recordTimeline(() => chats.use.row('chat-1'));
    let pin!: Promise<PinResponse | null>;
    let mute!: Promise<MuteResponse | null>;

    act(() => {
      pin = pinChat.run({ id: 'chat-1' });
      mute = muteChat.run({ id: 'chat-1' });
    });
    expect(frames.last()).toMatchObject({ pinned: true, muted: true });
    mutations.shift()?.reject(new Error('pin failed'));
    await act(async () => {
      await expect(pin).rejects.toThrow('pin failed');
    });

    const afterRollback = frames.last();
    mutations.shift()?.resolve({ muteChat: { ...initialRow, pinned: false, muted: true } });
    await act(async () => {
      await mute;
    });

    expect(afterRollback).toMatchObject({ pinned: false, muted: true });
    frames.unmount();
  });

  it('preserves a later pending patch on the same field when the earlier patch rolls back', async () => {
    const { chats, mutations } = createFixture('SameFieldRollback');
    const setRevision = chats.mutation<PinResponse, { id: string; rev: number }, ChatRow, ChatRow>('set-revision', {
      document,
      result: 'pinChat',
      dedupe: false,
      optimistic: { method: 'patch', model: chats, selectId: input => input.id, selectPatch: input => ({ rev: input.rev }) }
    });
    chats.insertStored(initialRow);
    const reader = recordTimeline(() => chats.use.row('chat-1'));
    let first!: Promise<PinResponse | null>;
    let second!: Promise<PinResponse | null>;

    act(() => {
      first = setRevision.run({ id: 'chat-1', rev: 11 });
      second = setRevision.run({ id: 'chat-1', rev: 12 });
    });
    expect(reader.last()?.rev).toBe(12);

    mutations.shift()?.reject(new Error('first revision failed'));
    await act(async () => {
      await expect(first).rejects.toThrow('first revision failed');
    });

    expect(reader.last()?.rev).toBe(12);
    mutations.shift()?.resolve({ pinChat: { ...initialRow, rev: 12 } });
    await act(async () => {
      await second;
    });
    reader.unmount();
  });

  it('preserves a later pending patch that writes the same field value when the earlier patch rolls back', async () => {
    const { chats, pinChat, mutations } = createFixture('SameValueRollback');
    chats.insertStored(initialRow);
    const reader = recordTimeline(() => chats.use.row('chat-1'));
    let first!: Promise<PinResponse | null>;
    let second!: Promise<PinResponse | null>;

    act(() => {
      first = pinChat.run({ id: 'chat-1' });
      second = pinChat.run({ id: 'chat-1' });
    });
    expect(reader.last()?.pinned).toBe(true);

    mutations.shift()?.reject(new Error('first pin failed'));
    await act(async () => {
      await expect(first).rejects.toThrow('first pin failed');
    });

    expect(reader.last()?.pinned).toBe(true);
    mutations.shift()?.resolve({ pinChat: { ...initialRow, pinned: true } });
    await act(async () => {
      await second;
    });
    reader.unmount();
  });

  it('restores the latest earlier pending same-field value when the later patch rolls back first', async () => {
    const { chats, mutations } = createFixture('LatestPendingRollback');
    const setRevision = chats.mutation<PinResponse, { id: string; rev: number }, ChatRow, ChatRow>('set-revision', {
      document,
      result: 'pinChat',
      dedupe: false,
      optimistic: { method: 'patch', model: chats, selectId: input => input.id, selectPatch: input => ({ rev: input.rev }) }
    });
    chats.insertStored(initialRow);
    const reader = recordTimeline(() => chats.use.row('chat-1'));
    let first!: Promise<PinResponse | null>;
    let second!: Promise<PinResponse | null>;

    act(() => {
      first = setRevision.run({ id: 'chat-1', rev: 11 });
      second = setRevision.run({ id: 'chat-1', rev: 12 });
    });
    mutations[1]?.reject(new Error('later revision failed'));
    await act(async () => {
      await expect(second).rejects.toThrow('later revision failed');
    });

    expect(reader.last()?.rev).toBe(11);
    mutations[0]?.resolve({ pinChat: { ...initialRow, rev: 11 } });
    await act(async () => {
      await first;
    });
    reader.unmount();
  });

  it('restores the pre-optimistic value when all same-field patches roll back', async () => {
    const { chats, mutations } = createFixture('AllSameFieldRollback');
    const setRevision = chats.mutation<PinResponse, { id: string; rev: number }, ChatRow, ChatRow>('set-revision', {
      document,
      result: 'pinChat',
      dedupe: false,
      optimistic: { method: 'patch', model: chats, selectId: input => input.id, selectPatch: input => ({ rev: input.rev }) }
    });
    chats.insertStored(initialRow);
    const reader = recordTimeline(() => chats.use.row('chat-1'));
    let first!: Promise<PinResponse | null>;
    let second!: Promise<PinResponse | null>;

    act(() => {
      first = setRevision.run({ id: 'chat-1', rev: 11 });
      second = setRevision.run({ id: 'chat-1', rev: 12 });
    });
    mutations[1]?.reject(new Error('later revision failed'));
    await act(async () => {
      await expect(second).rejects.toThrow('later revision failed');
    });
    mutations[0]?.reject(new Error('earlier revision failed'));
    await act(async () => {
      await expect(first).rejects.toThrow('earlier revision failed');
    });

    expect(reader.last()?.rev).toBe(10);
    reader.unmount();
  });

  it('keeps the latest remaining pending value in a three-patch same-field chain', async () => {
    const { chats, mutations } = createFixture('ThreePatchChain');
    const setRevision = chats.mutation<PinResponse, { id: string; rev: number }, ChatRow, ChatRow>('set-revision', {
      document,
      result: 'pinChat',
      dedupe: false,
      optimistic: { method: 'patch', model: chats, selectId: input => input.id, selectPatch: input => ({ rev: input.rev }) }
    });
    chats.insertStored(initialRow);
    const reader = recordTimeline(() => chats.use.row('chat-1'));
    let first!: Promise<PinResponse | null>;
    let second!: Promise<PinResponse | null>;
    let third!: Promise<PinResponse | null>;

    act(() => {
      first = setRevision.run({ id: 'chat-1', rev: 1 });
      second = setRevision.run({ id: 'chat-1', rev: 2 });
      third = setRevision.run({ id: 'chat-1', rev: 3 });
    });
    mutations[1]?.reject(new Error('middle revision failed'));
    await act(async () => {
      await expect(second).rejects.toThrow('middle revision failed');
    });

    expect(reader.last()?.rev).toBe(3);
    mutations[0]?.resolve({ pinChat: { ...initialRow, rev: 1 } });
    mutations[2]?.resolve({ pinChat: { ...initialRow, rev: 3 } });
    await act(async () => {
      await Promise.all([first, third]);
    });
    reader.unmount();
  });

  it('W18 mergePolicy preserves a later successful mute when commits resolve out of order', async () => {
    const { chats, pinChat, muteChat, mutations } = createFixture('W18Guarded', true);
    chats.insertStored(initialRow);
    const reader = recordTimeline(() => chats.use.row('chat-1'));
    let pin!: Promise<PinResponse | null>;
    let mute!: Promise<MuteResponse | null>;

    act(() => {
      pin = pinChat.run({ id: 'chat-1' });
      mute = muteChat.run({ id: 'chat-1' });
    });
    mutations[1]?.resolve({ muteChat: { ...initialRow, pinned: true, muted: true, rev: 12 } });
    await act(async () => {
      await mute;
    });
    mutations[0]?.resolve({ pinChat: { ...initialRow, pinned: true, muted: false, rev: 11 } });
    await act(async () => {
      await pin;
    });

    expect(reader.last()).toMatchObject({ pinned: true, muted: true, rev: 12 });
    reader.unmount();
  });

  it('W18 control allows a late stale commit to win without a mergePolicy guard', async () => {
    const { chats, pinChat, muteChat, mutations } = createFixture('W18Control');
    chats.insertStored(initialRow);
    const reader = recordTimeline(() => chats.use.row('chat-1'));
    let pin!: Promise<PinResponse | null>;
    let mute!: Promise<MuteResponse | null>;

    act(() => {
      pin = pinChat.run({ id: 'chat-1' });
      mute = muteChat.run({ id: 'chat-1' });
    });
    mutations[1]?.resolve({ muteChat: { ...initialRow, pinned: true, muted: true, rev: 12 } });
    await act(async () => {
      await mute;
    });
    mutations[0]?.resolve({ pinChat: { ...initialRow, pinned: true, muted: false, rev: 11 } });
    await act(async () => {
      await pin;
    });

    expect(reader.last()).toMatchObject({ pinned: true, muted: false, rev: 11 });
    reader.unmount();
  });
});
