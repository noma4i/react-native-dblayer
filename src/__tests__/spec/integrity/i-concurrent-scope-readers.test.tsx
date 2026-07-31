import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { DbProvider, configureDb, defineModelRuntime, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, settle } from '../helpers/harness';

const document = { kind: 'Document', definitions: [] } as never;

type Row = { id: string; chatId: string; text: string };
type Response = { rows: Row[] };

/**
 * One scope, many readers: concurrent mounts of the same query scope share one transport call,
 * and an invalidate that lands while that call is in flight produces exactly one follow-up
 * refetch - never a dropped result and never a storm.
 */
const createHarness = (suffix: string) => {
  const resolvers: Array<(rows: Row[]) => void> = [];
  let calls = 0;
  const transport = createMockTransport({
    query: <TData,>() =>
      new Promise<{ data: TData }>(resolve => {
        calls += 1;
        resolvers.push(rows => resolve({ data: { rows } as TData }));
      })
  });
  configureDb({ storage: createMemoryPlane(), transport });
  const messages = defineModelRuntime({
    id: `SpecConcurrentReaders${suffix}`,
    name: `SpecConcurrentReaders${suffix}`,
    fields: { chatId: f.str(), text: f.str() },
    scopes: { thread: ({ by: { chatId: 'chatId' } }) }
  });
  const threadQuery = messages.query<Response, { chatId: string }, { chatId: string }, Row>('thread', {
    document,
    vars: scopeValue => ({ chatId: scopeValue.chatId }),
    select: data => data.rows,
    into: messages.scopes.thread,
    coverage: 'page',
    staleTime: Infinity
  });
  return {
    threadQuery,
    callCount: () => calls,
    resolveNext: (rows: Row[]) => {
      const resolve = resolvers.shift();
      if (!resolve) throw new Error('no pending transport call');
      resolve(rows);
    }
  };
};

describe('concurrent readers of one query scope', () => {
  it('coalesces two concurrent mounts of the same scope into one transport call', async () => {
    const harness = createHarness('Dedupe');
    const results: Array<() => Row[]> = [];
    const Reader = () => {
      const result = harness.threadQuery.use({ chatId: 'chat-1' });
      results.push(() => result.data as Row[]);
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(
        React.createElement(DbProvider, null, React.createElement(Reader), React.createElement(Reader))
      );
    });
    await act(async () => {
      await settle();
    });
    expect(harness.callCount()).toBe(1);

    await act(async () => {
      harness.resolveNext([{ id: 'm-1', chatId: 'chat-1', text: 'shared' }]);
      await settle();
    });

    expect(harness.callCount()).toBe(1);
    expect(results.at(-1)!().map(row => row.id)).toEqual(['m-1']);
    act(() => root.unmount());
  });

  it('turns an invalidate landing during an in-flight fetch into exactly one follow-up refetch', async () => {
    const harness = createHarness('InvalidateInFlight');
    let latest: Row[] = [];
    const Reader = () => {
      latest = harness.threadQuery.use({ chatId: 'chat-1' }).data as Row[];
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await act(async () => {
      await settle();
    });
    expect(harness.callCount()).toBe(1);

    act(() => {
      harness.threadQuery.invalidate({ chatId: 'chat-1' });
    });

    await act(async () => {
      harness.resolveNext([{ id: 'm-old', chatId: 'chat-1', text: 'stale page' }]);
      await settle();
    });
    await act(async () => {
      if (harness.callCount() > 1) harness.resolveNext([{ id: 'm-new', chatId: 'chat-1', text: 'fresh page' }]);
      await settle();
    });

    // The invalidate owes exactly one follow-up call: the in-flight response predates the
    // invalidate and cannot satisfy it, and nothing owes a third call.
    expect(harness.callCount()).toBe(2);
    expect(latest.map(row => row.id).sort()).toEqual(['m-new', 'm-old']);
    await act(async () => {
      await settle();
    });
    expect(harness.callCount()).toBe(2);
    act(() => root.unmount());
  });
});
