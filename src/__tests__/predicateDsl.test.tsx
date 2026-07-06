import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { defineModel, devClearAllDataAndState } from '../index';
import { installMemoryStorage } from './helpers/testRuntime';

type ChatInput = {
  id: string;
  chatId: string;
  status: 'primary' | 'secondary';
  premium?: boolean;
  pinned?: boolean;
  kind: 'user' | 'system';
  lastActivityAt: number;
  createdAt: string;
  updatedAt?: string | null;
};

type Chat = ChatInput & {
  premium: boolean;
  pinned: boolean;
  updatedAt: string | null;
};

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const renderHook = <T,>(read: () => T) => {
  let current!: T;
  let renderer!: TestRenderer.ReactTestRenderer;

  const Harness = () => {
    current = read();
    return null;
  };

  act(() => {
    renderer = TestRenderer.create(<Harness />);
  });

  return {
    get current() {
      return current;
    },
    async flush() {
      await flush();
    },
    unmount() {
      act(() => {
        renderer.unmount();
      });
    }
  };
};

let modelCounter = 0;

const createChatModel = () =>
  defineModel<ChatInput, Chat>({
    id: `predicate-chats-${modelCounter++}`,
    name: `PredicateChatModel:${modelCounter}`,
    normalize: input => ({
      ...input,
      premium: input.premium ?? false,
      pinned: input.pinned ?? false,
      updatedAt: input.updatedAt ?? null
    }),
    replace: {}
  });

const seedChats = (model: ReturnType<typeof createChatModel>) => {
  act(() => {
    model.insertStored({ id: 'a', chatId: 'c1', status: 'secondary', premium: false, pinned: false, kind: 'user', lastActivityAt: 10, createdAt: '2026-01-01', updatedAt: null });
    model.insertStored({ id: 'b', chatId: 'c2', status: 'primary', premium: true, pinned: true, kind: 'user', lastActivityAt: 30, createdAt: '2026-01-02', updatedAt: null });
    model.insertStored({ id: 'c', chatId: 'c3', status: 'primary', premium: true, pinned: true, kind: 'system', lastActivityAt: 40, createdAt: '2026-01-03', updatedAt: null });
    model.insertStored({ id: 'd', chatId: 'c1', status: 'primary', premium: false, pinned: true, kind: 'user', lastActivityAt: 20, createdAt: '2026-01-04', updatedAt: null });
    model.insertStored({ id: 'e', chatId: 'c1', status: 'secondary', premium: false, pinned: false, kind: 'system', lastActivityAt: 50, createdAt: '2026-01-05', updatedAt: null });
  });
};

describe('typed predicate DSL', () => {
  afterEach(async () => {
    await flush();
    devClearAllDataAndState();
  });

  it('matches compound predicates, order, limit, count, first, and snapshot aliases', async () => {
    installMemoryStorage();
    const model = createChatModel();
    seedChats(model);

    const complexRows = renderHook(() =>
      model.where(
        {
          and: [
            { or: [{ status: 'secondary' }, { and: [{ status: 'primary' }, { premium: true }] }] },
            { not: { kind: 'system' } }
          ]
        },
        { orderBy: { field: 'lastActivityAt', direction: 'desc' }, limit: 25 }
      )
    );
    const count = renderHook(() => model.count({ and: [{ status: 'primary', pinned: true }, { not: { kind: 'system' } }] }));
    const primaryRows = renderHook(() =>
      model.where(
        { and: [{ status: 'primary' }, { or: [{ pinned: true }, { kind: 'system' }] }] },
        { orderBy: { field: 'lastActivityAt', direction: 'desc' } }
      )
    );
    const latestInChat = renderHook(() => model.first({ chatId: 'c1' }, { orderBy: { field: 'createdAt', direction: 'desc' } }));

    await complexRows.flush();

    expect(complexRows.current.map(row => row.id)).toEqual(['b', 'a']);
    expect(count.current).toBe(2);
    expect(primaryRows.current.map(row => row.id)).toEqual(['c', 'b', 'd']);
    expect(latestInChat.current?.id).toBe('e');
    expect(model.getFirstWhere({ chatId: 'c1' }, { orderBy: { field: 'createdAt', direction: 'desc' } })?.id).toBe('e');
    expect(model.getFirst({ chatId: 'c1' }, { orderBy: { field: 'createdAt', direction: 'desc' } })?.id).toBe('e');

    act(() => {
      model.insertStored({ id: 'f', chatId: 'c4', status: 'secondary', premium: false, pinned: false, kind: 'user', lastActivityAt: 60, createdAt: '2026-01-06', updatedAt: null });
      model.patch('d', { premium: true, lastActivityAt: 70, updatedAt: '2026-01-07' });
    });

    await complexRows.flush();

    expect(complexRows.current.map(row => row.id)).toEqual(['d', 'f', 'b', 'a']);
    expect(count.current).toBe(2);

    complexRows.unmount();
    count.unmount();
    primaryRows.unmount();
    latestInChat.unmount();
  });

  it('supports reactive and snapshot singleton first reads', async () => {
    installMemoryStorage();
    const model = createChatModel();

    const singleton = renderHook(() => model.first());
    expect(singleton.current).toBeUndefined();
    expect(model.getFirst()).toBeUndefined();

    act(() => {
      model.insertStored({ id: 'only', chatId: 'c1', status: 'primary', premium: false, pinned: false, kind: 'user', lastActivityAt: 1, createdAt: '2026-01-01', updatedAt: null });
    });

    await singleton.flush();

    expect(singleton.current?.id).toBe('only');
    expect(model.getFirst()?.id).toBe('only');

    singleton.unmount();
  });
});
