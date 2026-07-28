import { act } from 'react';
import { configureDb, defineModel, f, resetRuntime, scope } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

const QUERY_DOCUMENT = { kind: 'Document', definitions: [] } as never;
const SUBSCRIPTION_DOCUMENT = { kind: 'Document', definitions: [] } as never;

type MessageRow = { id: string; chatId: string; text: string };

/**
 * Consumer contract for the `Model.query(name, { live })` surface: a live query owns exactly one
 * transport subscription shared by every mounted reader (refcount), opens it lazily on the first
 * reader, closes it after the last one, and survives a runtime reset without going silent.
 */
const createLiveHarness = (suffix: string) => {
  const pushHandlers: Array<{ next: (data: unknown) => void; error: (error: unknown) => void }> = [];
  const unsubscribes: Array<jest.Mock> = [];
  const transport = createMockTransport({
    query: async <TData,>() => ({ data: { rows: [] } as TData }),
    subscribe: (_options, handlers) => {
      pushHandlers.push(handlers);
      const unsubscribe = jest.fn();
      unsubscribes.push(unsubscribe);
      return unsubscribe;
    }
  });
  configureDb({ storage: createMemoryPlane(), transport });
  const messages = defineModel({
    id: `SpecLiveMessages${suffix}`,
    name: `SpecLiveMessages${suffix}`,
    fields: { chatId: f.str(), text: f.str() },
    scopes: { thread: scope<{ id: string; chatId: string }>({ by: { chatId: 'chatId' } }) }
  });
  const threadQuery = messages.query<{ rows: MessageRow[] }, { chatId: string }, { chatId: string }, MessageRow>('thread', {
    document: QUERY_DOCUMENT,
    vars: scopeValue => ({ chatId: scopeValue.chatId }),
    select: data => data.rows,
    into: messages.scopes.thread,
    staleTime: Infinity,
    live: {
      messageAdded: { document: SUBSCRIPTION_DOCUMENT, apply: 'upsert' }
    }
  });
  const subscribeCount = () => transport.calls.filter(call => call.kind === 'subscribe').length;
  return { messages, threadQuery, subscribeCount, pushHandlers, unsubscribes };
};

describe('live query subscription lifecycle', () => {
  it('opens no subscription at definition time and exactly one on the first mounted reader', () => {
    const harness = createLiveHarness('Lazy');
    expect(harness.subscribeCount()).toBe(0);

    const reader = renderCounted(() => harness.threadQuery.use({ chatId: 'chat-1' }));

    expect(harness.subscribeCount()).toBe(1);
    reader.unmount();
  });

  it('shares one subscription across concurrent readers instead of opening one per reader', () => {
    const harness = createLiveHarness('Shared');

    const first = renderCounted(() => harness.threadQuery.use({ chatId: 'chat-1' }));
    const second = renderCounted(() => harness.threadQuery.use({ chatId: 'chat-2' }));

    expect(harness.subscribeCount()).toBe(1);
    first.unmount();
    second.unmount();
  });

  it('keeps the subscription while a reader remains and closes it when the last reader unmounts', () => {
    const harness = createLiveHarness('Refcount');
    const first = renderCounted(() => harness.threadQuery.use({ chatId: 'chat-1' }));
    const second = renderCounted(() => harness.threadQuery.use({ chatId: 'chat-2' }));

    first.unmount();
    expect(harness.unsubscribes[0]).not.toHaveBeenCalled();

    second.unmount();
    expect(harness.unsubscribes[0]).toHaveBeenCalledTimes(1);
  });

  it('reopens the subscription when a reader mounts again after a full teardown', () => {
    const harness = createLiveHarness('Remount');
    const first = renderCounted(() => harness.threadQuery.use({ chatId: 'chat-1' }));
    first.unmount();
    expect(harness.subscribeCount()).toBe(1);

    const second = renderCounted(() => harness.threadQuery.use({ chatId: 'chat-1' }));

    expect(harness.subscribeCount()).toBe(2);
    second.unmount();
  });

  it('delivers a pushed subscription payload into the store so a mounted reader re-renders with the row', () => {
    const harness = createLiveHarness('Push');
    const reader = renderCounted(() => harness.threadQuery.use({ chatId: 'chat-1' }));

    act(() => harness.pushHandlers[0]!.next({ messageAdded: { id: 'm-live-1', chatId: 'chat-1', text: 'pushed' } }));

    expect((reader.result().data as MessageRow[]).map(row => row.id)).toEqual(['m-live-1']);
    reader.unmount();
  });

  it('applies an imperative live payload through handle.live.apply without a transport push', () => {
    const harness = createLiveHarness('Imperative');

    harness.threadQuery.live.apply('messageAdded', { id: 'm-imperative-1', chatId: 'chat-1', text: 'echoed' });

    expect(harness.messages.find('m-imperative-1')).toMatchObject({ id: 'm-imperative-1', text: 'echoed' });
  });

  it('reopens the subscription after a runtime reset while a reader stays mounted', () => {
    const harness = createLiveHarness('Reset');
    const reader = renderCounted(() => harness.threadQuery.use({ chatId: 'chat-1' }));
    expect(harness.subscribeCount()).toBe(1);

    act(() => resetRuntime());

    expect(harness.unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(harness.subscribeCount()).toBe(2);
    expect(harness.unsubscribes[1]).not.toHaveBeenCalled();

    act(() => harness.pushHandlers[1]!.next({ messageAdded: { id: 'm-after-reset', chatId: 'chat-1', text: 'alive' } }));
    expect(harness.messages.find('m-after-reset')).toMatchObject({ id: 'm-after-reset' });
    reader.unmount();
  });
});
