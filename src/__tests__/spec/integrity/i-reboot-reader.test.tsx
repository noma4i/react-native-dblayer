import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { DbProvider, bootDb, configureDb, defineModelRuntime, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, settle } from '../helpers/harness';

const document = { kind: 'Document', definitions: [] } as never;

type Row = { id: string; chatId: string; seq: number; text: string };
type Response = { rows: Row[] };

/**
 * The reboot contract at the READER level: what a mounted hook shows before a process restart is
 * what the same hook shows after configure + boot over the same storage - same rows, same order,
 * from disk, without a network fetch while the query is still fresh.
 */
describe('reader-level reboot round-trip', () => {
  it('serves the same rows in the same order from disk after configure and boot, without refetching', async () => {
    const storage = createMemoryPlane();
    let calls = 0;
    const respond = <TData,>(): Promise<{ data: TData }> => {
      calls += 1;
      return Promise.resolve({
        data: {
          rows: [
            { id: 'm-2', chatId: 'chat-1', seq: 2, text: 'newer' },
            { id: 'm-1', chatId: 'chat-1', seq: 1, text: 'older' }
          ]
        } as TData
      });
    };
    const buildRuntime = () => {
      configureDb({ storage, transport: createMockTransport({ query: respond }) });
      const messages = defineModelRuntime({
        id: 'SpecRebootReader',
        name: 'SpecRebootReader',
        fields: { chatId: f.str(), seq: f.num(), text: f.str() },
        scopes: {
          thread: ({
            by: { chatId: 'chatId' },
            sort: { comparator: (left: Row, right: Row) => right.seq - left.seq }
          })
        }
      });
      const threadQuery = messages.query<Response, { chatId: string }, { chatId: string }, Row>('thread', {
        document,
        vars: scopeValue => ({ chatId: scopeValue.chatId }),
        select: data => data.rows,
        into: messages.scopes.thread,
        coverage: 'page',
        // Finite freshness persists across restarts; Infinity deliberately does not (no window).
        staleTime: 60_000
      });
      return { threadQuery };
    };

    const first = buildRuntime();
    await act(async () => {
      await bootDb();
    });
    let firstRows: Row[] = [];
    const FirstReader = () => {
      firstRows = first.threadQuery.use({ chatId: 'chat-1' }).data as Row[];
      return null;
    };
    let firstRoot!: TestRenderer.ReactTestRenderer;
    act(() => {
      firstRoot = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(FirstReader)));
    });
    await act(async () => {
      await settle();
    });
    expect(firstRows.map(row => row.id)).toEqual(['m-2', 'm-1']);
    expect(calls).toBe(1);
    act(() => firstRoot.unmount());

    // The durable query record is what carries freshness across the restart below.
    expect(storage.snapshotKeys().filter(key => key.startsWith('dbl:query'))).not.toEqual([]);
    // Process restart: a new runtime generation over the SAME storage.
    const second = buildRuntime();
    await act(async () => {
      await bootDb();
    });
    let secondRows: Row[] = [];
    const SecondReader = () => {
      secondRows = second.threadQuery.use({ chatId: 'chat-1' }).data as Row[];
      return null;
    };
    let secondRoot!: TestRenderer.ReactTestRenderer;
    act(() => {
      secondRoot = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(SecondReader)));
    });
    await act(async () => {
      await settle();
    });

    expect(secondRows.map(row => row.id)).toEqual(['m-2', 'm-1']);
    expect(secondRows.map(row => row.text)).toEqual(['newer', 'older']);
    // Freshness survived the restart: the reader was served from disk, not the network.
    expect(calls).toBe(1);
    act(() => secondRoot.unmount());
  });

  it('carries an invalidate issued before the restart into a refetch after it', async () => {
    const storage = createMemoryPlane();
    let calls = 0;
    const respond = <TData,>(): Promise<{ data: TData }> => {
      calls += 1;
      return Promise.resolve({ data: { rows: [{ id: `m-${calls}`, chatId: 'chat-1', seq: calls, text: `page-${calls}` }] } as TData });
    };
    const buildRuntime = () => {
      configureDb({ storage, transport: createMockTransport({ query: respond }) });
      const messages = defineModelRuntime({
        id: 'SpecRebootInvalidate',
        name: 'SpecRebootInvalidate',
        fields: { chatId: f.str(), seq: f.num(), text: f.str() },
        scopes: { thread: ({ by: { chatId: 'chatId' } }) }
      });
      const threadQuery = messages.query<Response, { chatId: string }, { chatId: string }, Row>('thread', {
        document,
        vars: scopeValue => ({ chatId: scopeValue.chatId }),
        select: data => data.rows,
        into: messages.scopes.thread,
        coverage: 'page',
        staleTime: 60_000
      });
      return { threadQuery };
    };

    const first = buildRuntime();
    await act(async () => {
      await bootDb();
    });
    const FirstReader = () => {
      first.threadQuery.use({ chatId: 'chat-1' });
      return null;
    };
    let firstRoot!: TestRenderer.ReactTestRenderer;
    act(() => {
      firstRoot = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(FirstReader)));
    });
    await act(async () => {
      await settle();
    });
    expect(calls).toBe(1);
    act(() => firstRoot.unmount());

    // Nobody is mounted: the invalidate can only reach the durable record.
    act(() => {
      first.threadQuery.invalidate({ chatId: 'chat-1' });
    });

    const second = buildRuntime();
    await act(async () => {
      await bootDb();
    });
    const SecondReader = () => {
      second.threadQuery.use({ chatId: 'chat-1' });
      return null;
    };
    let secondRoot!: TestRenderer.ReactTestRenderer;
    act(() => {
      secondRoot = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(SecondReader)));
    });
    await act(async () => {
      await settle();
    });

    // The persisted record restored as invalidated, so the fresh window did not silence the refetch.
    expect(calls).toBe(2);
    act(() => secondRoot.unmount());
  });
});
