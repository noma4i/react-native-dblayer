import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { DbProvider, configureDb, defineModel, defineShape, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, recordTimeline, settle } from '../helpers/harness';

type ChatRow = { id: string; groupId: string; pinned: boolean; muted: boolean; read: boolean; rev: number };
type ScopeValue = { groupId: string };
type QueryResponse = { chats: ChatRow[] };
type PinResponse = { pinChat: ChatRow };
type MuteResponse = { muteChat: ChatRow };
type RevisionResponse = { setRevision: ChatRow };
type PinInput = { id: string };
type MuteInput = { id: string };
type RevisionInput = { id: string; rev: number };
type QueryVariables = ScopeValue;
type PinVariables = { input: PinInput };
type MuteVariables = { input: MuteInput };
type RevisionVariables = { input: RevisionInput };
type Deferred<T> = { resolve: (data: T) => void; reject: (error: Error) => void };

const chatsDocument: TypedDocumentNode<QueryResponse, QueryVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const pinDocument: TypedDocumentNode<PinResponse, PinVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const muteDocument: TypedDocumentNode<MuteResponse, MuteVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const revisionDocument: TypedDocumentNode<RevisionResponse, RevisionVariables> = {
  kind: Kind.DOCUMENT,
  definitions: []
};
const ChatSchema = defineShape<ChatRow>()({
  groupId: f.str(),
  pinned: f.bool(),
  muted: f.bool(),
  read: f.bool(),
  rev: f.num()
});

const createQueues = () => {
  const queries: Deferred<QueryResponse>[] = [];
  const mutations: Deferred<PinResponse | MuteResponse | RevisionResponse>[] = [];
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
  return { queries, mutations };
};

const createFixture = (suffix: string, guarded = false) => {
  const { queries, mutations } = createQueues();
  const chats = defineModel(`SpecWriteCausality${suffix}`, {
    schema: ChatSchema,
    relations: owner => ({
      byGroup: {
        by: { groupId: 'groupId' },
        sort: 'server-order',
        remote: owner.gql.list(chatsDocument, {
          variables: (scope: ScopeValue) => scope,
          select: data => data.chats
        })
      }
    }),
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
              patch: {
                groupId: data.pinChat.groupId,
                pinned: data.pinChat.pinned,
                muted: data.pinChat.muted,
                read: data.pinChat.read,
                rev: data.pinChat.rev
              }
            })
          }
        }
      }),
      mute: owner.gql.action(muteDocument, {
        mode: 'request',
        result: 'muteChat',
        variables: (input: MuteInput) => ({ input }),
        optimistic: {
          root: {
            update: {
              select: ({ input }) => ({ id: input.id, patch: { muted: true } })
            }
          }
        },
        root: {
          update: {
            select: ({ data }) => ({
              id: data.muteChat.id,
              patch: {
                groupId: data.muteChat.groupId,
                pinned: data.muteChat.pinned,
                muted: data.muteChat.muted,
                read: data.muteChat.read,
                rev: data.muteChat.rev
              }
            })
          }
        }
      })
    }),
    write: guarded
      ? {
          groups: [
            {
              fields: ['pinned', 'muted', 'rev'],
              policy: { monotonic: { tuple: ['rev'] }, on: ['patch'] }
            }
          ]
        }
      : undefined
  });
  return { chats, queries, mutations };
};

const createRevisionFixture = (suffix: string, guarded = false) => {
  const { mutations } = createQueues();
  const chats = defineModel(`SpecWriteCausality${suffix}`, {
    schema: ChatSchema,
    actions: owner => ({
      setRevision: owner.gql.action(revisionDocument, {
        mode: 'request',
        result: 'setRevision',
        variables: (input: RevisionInput) => ({ input }),
        optimistic: {
          root: {
            update: {
              select: ({ input }) => ({ id: input.id, patch: { rev: input.rev } })
            }
          }
        },
        root: {
          update: {
            select: ({ data }) => ({
              id: data.setRevision.id,
              patch: {
                groupId: data.setRevision.groupId,
                pinned: data.setRevision.pinned,
                muted: data.setRevision.muted,
                read: data.setRevision.read,
                rev: data.setRevision.rev
              }
            })
          }
        }
      })
    }),
    write: guarded
      ? {
          groups: [
            {
              fields: ['pinned', 'muted', 'rev'],
              policy: { monotonic: { tuple: ['rev'] }, on: ['patch'] }
            }
          ]
        }
      : undefined
  });
  return { chats, mutations };
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
    const { chats, queries, mutations } = createFixture('W15');
    const byGroup = chats.byGroup({ groupId: 'g' });
    const frames = recordTimeline(() => byGroup.use().data[0]?.pinned);
    const queryReader = renderInProvider(() => byGroup.use().data);

    await settle(6, { macro: true });
    queries.shift()?.resolve({ chats: [initialRow] });
    await settle(6, { macro: true });
    let pin!: Promise<PinResponse['pinChat'] | null>;
    act(() => {
      pin = chats.actions.pin.run({ id: 'chat-1' });
    });
    const frameStart = frames.frames().length;
    expect(frames.last()).toBe(true);

    act(() => {
      void byGroup.refresh();
    });
    await settle(6, { macro: true });
    queries.shift()?.resolve({ chats: [initialRow] });
    await settle(6, { macro: true });

    const pendingFrames = frames.frames().slice(frameStart);
    mutations.shift()?.resolve({ pinChat: { ...initialRow, pinned: true } });
    await act(async () => {
      await pin;
    });

    expect(pendingFrames).not.toContain(false);
    frames.unmount();
    queryReader.unmount();
  });

  it('commits its own authoritative WritePlan write after releasing the optimistic patch overlay', async () => {
    const { chats, mutations } = createFixture('OwnWritePlan');
    chats.insert(initialRow);
    const byGroup = chats.byGroup({ groupId: 'g' });
    const reader = recordTimeline(() => byGroup.use().data[0]);
    let pin!: Promise<PinResponse['pinChat'] | null>;

    act(() => {
      pin = chats.actions.pin.run({ id: 'chat-1' });
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
    const { chats, mutations } = createFixture('W17');
    chats.insert(initialRow);
    const byGroup = chats.byGroup({ groupId: 'g' });
    const frames = recordTimeline(() => byGroup.use().data[0]);
    let pin!: Promise<PinResponse['pinChat'] | null>;
    let mute!: Promise<MuteResponse['muteChat'] | null>;

    act(() => {
      pin = chats.actions.pin.run({ id: 'chat-1' });
      mute = chats.actions.mute.run({ id: 'chat-1' });
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
    const { chats, mutations } = createRevisionFixture('SameFieldRollback');
    chats.insert(initialRow);
    const reader = recordTimeline(() => chats.useFind('chat-1'));
    let first!: Promise<RevisionResponse['setRevision'] | null>;
    let second!: Promise<RevisionResponse['setRevision'] | null>;

    act(() => {
      first = chats.actions.setRevision.run({ id: 'chat-1', rev: 11 });
      second = chats.actions.setRevision.run({ id: 'chat-1', rev: 12 });
    });
    expect(reader.last()?.rev).toBe(12);

    mutations.shift()?.reject(new Error('first revision failed'));
    await act(async () => {
      await expect(first).rejects.toThrow('first revision failed');
    });

    expect(reader.last()?.rev).toBe(12);
    mutations.shift()?.resolve({ setRevision: { ...initialRow, rev: 12 } });
    await act(async () => {
      await second;
    });
    reader.unmount();
  });

  it('preserves a later pending patch that writes the same field value when the earlier patch rolls back', async () => {
    const { chats, mutations } = createFixture('SameValueRollback');
    chats.insert(initialRow);
    const byGroup = chats.byGroup({ groupId: 'g' });
    const reader = recordTimeline(() => byGroup.use().data[0]);
    let first!: Promise<PinResponse['pinChat'] | null>;
    let second!: Promise<PinResponse['pinChat'] | null>;

    act(() => {
      first = chats.actions.pin.run({ id: 'chat-1' });
      second = chats.actions.pin.run({ id: 'chat-1' });
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
    const { chats, mutations } = createRevisionFixture('LatestPendingRollback');
    chats.insert(initialRow);
    const reader = recordTimeline(() => chats.useFind('chat-1'));
    let first!: Promise<RevisionResponse['setRevision'] | null>;
    let second!: Promise<RevisionResponse['setRevision'] | null>;

    act(() => {
      first = chats.actions.setRevision.run({ id: 'chat-1', rev: 11 });
      second = chats.actions.setRevision.run({ id: 'chat-1', rev: 12 });
    });
    mutations[1]?.reject(new Error('later revision failed'));
    await act(async () => {
      await expect(second).rejects.toThrow('later revision failed');
    });

    expect(reader.last()?.rev).toBe(11);
    mutations[0]?.resolve({ setRevision: { ...initialRow, rev: 11 } });
    await act(async () => {
      await first;
    });
    reader.unmount();
  });

  it('restores the pre-optimistic value when all same-field patches roll back', async () => {
    const { chats, mutations } = createRevisionFixture('AllSameFieldRollback');
    chats.insert(initialRow);
    const reader = recordTimeline(() => chats.useFind('chat-1'));
    let first!: Promise<RevisionResponse['setRevision'] | null>;
    let second!: Promise<RevisionResponse['setRevision'] | null>;

    act(() => {
      first = chats.actions.setRevision.run({ id: 'chat-1', rev: 11 });
      second = chats.actions.setRevision.run({ id: 'chat-1', rev: 12 });
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
    const { chats, mutations } = createRevisionFixture('ThreePatchChain');
    chats.insert(initialRow);
    const reader = recordTimeline(() => chats.useFind('chat-1'));
    let first!: Promise<RevisionResponse['setRevision'] | null>;
    let second!: Promise<RevisionResponse['setRevision'] | null>;
    let third!: Promise<RevisionResponse['setRevision'] | null>;

    act(() => {
      first = chats.actions.setRevision.run({ id: 'chat-1', rev: 1 });
      second = chats.actions.setRevision.run({ id: 'chat-1', rev: 2 });
      third = chats.actions.setRevision.run({ id: 'chat-1', rev: 3 });
    });
    mutations[1]?.reject(new Error('middle revision failed'));
    await act(async () => {
      await expect(second).rejects.toThrow('middle revision failed');
    });

    expect(reader.last()?.rev).toBe(3);
    mutations[0]?.resolve({ setRevision: { ...initialRow, rev: 1 } });
    mutations[2]?.resolve({ setRevision: { ...initialRow, rev: 3 } });
    await act(async () => {
      await Promise.all([first, third]);
    });
    reader.unmount();
  });

  it('W18 write policy preserves a later successful mute when commits resolve out of order', async () => {
    const { chats, mutations } = createFixture('W18Guarded', true);
    chats.insert(initialRow);
    const byGroup = chats.byGroup({ groupId: 'g' });
    const reader = recordTimeline(() => byGroup.use().data[0]);
    let pin!: Promise<PinResponse['pinChat'] | null>;
    let mute!: Promise<MuteResponse['muteChat'] | null>;

    act(() => {
      pin = chats.actions.pin.run({ id: 'chat-1' });
      mute = chats.actions.mute.run({ id: 'chat-1' });
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

  it('causal admission rejects a late stale commit without a write policy guard', async () => {
    const { chats, mutations } = createFixture('W18Control');
    chats.insert(initialRow);
    const byGroup = chats.byGroup({ groupId: 'g' });
    const reader = recordTimeline(() => byGroup.use().data[0]);
    let pin!: Promise<PinResponse['pinChat'] | null>;
    let mute!: Promise<MuteResponse['muteChat'] | null>;

    act(() => {
      pin = chats.actions.pin.run({ id: 'chat-1' });
      mute = chats.actions.mute.run({ id: 'chat-1' });
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
});
