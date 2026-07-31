import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { DbProvider, bootDb, compositeKey, configureDb, defineModelRuntime, encodePersistence, f } from '../../testApi';
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

/**
 * Adversarial matrix of the restored chain-metadata guard: a durable query record whose payload
 * violates exactly one metadata condition is dropped on restart and the reader refetches, instead
 * of hydrating a malformed chain. The untouched-record baseline lives in the round-trip test above.
 */
describe('restored chain metadata guard', () => {
  let variantSeq = 0;
  const violations: Array<[string, (payload: Record<string, unknown>, modelId: string) => unknown]> = [
    ['a numeric cursor', payload => ({ ...payload, cursor: 7 })],
    ['a string pages count', payload => ({ ...payload, pages: '1' })],
    ['a fractional pages count', payload => ({ ...payload, pages: 1.5 })],
    ['a negative pages count', payload => ({ ...payload, pages: -1 })],
    ['a string hasNextPage', payload => ({ ...payload, hasNextPage: 'no' })],
    ['a non-array ids value', payload => ({ ...payload, ids: 'r-1' })],
    ['a numeric ids entry', payload => ({ ...payload, ids: [...(payload.ids as string[]), 7] })],
    ['an unknown resultKind', payload => ({ ...payload, resultKind: 'weird' })],
    ['a non-record payload', () => 7],
    // Mixed valid + invalid ids: one surviving id must not carry a chain whose other id is broken.
    // The foreign entry reuses a LIVE row id, so only the model-prefix check can reject it.
    ['one id beside a foreign-model id', (payload, modelId) => ({ ...payload, ids: [...(payload.ids as string[]), compositeKey(`${modelId}Foreign`, 'm-1')] })],
    ['one id beside a ghost-membership id', (payload, modelId) => ({ ...payload, ids: [...(payload.ids as string[]), compositeKey(modelId, 'ghost-1')] })]
  ];

  it.each(violations)('refetches instead of restoring a record whose chain metadata has %s', async (_label, corrupt) => {
    const storage = createMemoryPlane();
    let calls = 0;
    const respond = <TData,>(): Promise<{ data: TData }> => {
      calls += 1;
      return Promise.resolve({ data: { rows: [{ id: `m-${calls}`, chatId: 'chat-1', seq: calls, text: `page-${calls}` }] } as TData });
    };
    const modelId = `SpecChainGuard${++variantSeq}`;
    const buildRuntime = () => {
      configureDb({ storage, transport: createMockTransport({ query: respond }) });
      const messages = defineModelRuntime({
        id: modelId,
        name: modelId,
        fields: { chatId: f.str(), seq: f.num(), text: f.str() },
        scopes: { thread: ({ by: { chatId: 'chatId' } }) }
      });
      return messages.query<Response, { chatId: string }, { chatId: string }, Row>('thread', {
        document,
        vars: scopeValue => ({ chatId: scopeValue.chatId }),
        select: data => data.rows,
        into: messages.scopes.thread,
        coverage: 'page',
        staleTime: 60_000
      });
    };

    const firstQuery = buildRuntime();
    await act(async () => {
      await bootDb();
    });
    const FirstReader = () => {
      firstQuery.use({ chatId: 'chat-1' });
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

    // Corrupt exactly one metadata condition on disk, re-encoding with the canonical codec.
    const [recordKey, ...extraKeys] = storage.snapshotKeys().filter(key => key.startsWith('dbl:query'));
    expect(extraKeys).toEqual([]);
    const envelope = JSON.parse(storage.get(recordKey!)!) as { schemaVersion: number; payload: Record<string, unknown> };
    const corrupted = { ...envelope.payload, payload: corrupt(envelope.payload.payload as Record<string, unknown>, modelId) };
    storage.set([{ key: recordKey!, value: encodePersistence(corrupted, envelope.schemaVersion) }]);

    const secondQuery = buildRuntime();
    await act(async () => {
      await bootDb();
    });
    let secondRows: Row[] = [];
    const SecondReader = () => {
      secondRows = secondQuery.use({ chatId: 'chat-1' }).data as Row[];
      return null;
    };
    let secondRoot!: TestRenderer.ReactTestRenderer;
    act(() => {
      secondRoot = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(SecondReader)));
    });
    await act(async () => {
      await settle();
    });

    // The malformed record must not hydrate: the reader goes back to the network. Page coverage
    // unions the refetched page with rows already living in the model plane.
    expect(calls).toBe(2);
    expect(secondRows.map(row => row.id)).toContain('m-2');
    act(() => secondRoot.unmount());
  });
});

/**
 * Declaration fingerprint discrimination: a persisted query record written under one declaration
 * must not restore under a declaration that differs in any pagination-identity property. Each pair
 * changes exactly one property across the restart; the same-declaration baseline lives in the
 * round-trip test above.
 */
describe('declaration fingerprint discrimination', () => {
  let pairSeq = 0;
  type Overrides = { direction?: 'forward' | 'backward'; cursorVar?: string; maxPages?: number; paged?: boolean };
  const pairs: Array<[string, Overrides, Overrides]> = [
    ['pagination direction', { direction: 'forward' }, { direction: 'backward' }],
    ['cursor variable name', { cursorVar: 'afterA' }, { cursorVar: 'afterB' }],
    ['page limit', { maxPages: 2 }, { maxPages: 3 }],
    ['paged shape', { paged: true }, { paged: false }]
  ];

  it.each(pairs)('refetches after a restart when the declaration changed its %s', async (_label, base, changed) => {
    const storage = createMemoryPlane();
    let calls = 0;
    const respond = <TData,>(): Promise<{ data: TData }> => {
      calls += 1;
      return Promise.resolve({ data: { rows: [{ id: `m-${calls}`, chatId: 'chat-1', seq: calls, text: `page-${calls}` }] } as TData });
    };
    const modelId = `SpecFingerprint${++pairSeq}`;
    const buildRuntime = (overrides: Overrides) => {
      configureDb({ storage, transport: createMockTransport({ query: respond }) });
      const messages = defineModelRuntime({
        id: modelId,
        name: modelId,
        fields: { chatId: f.str(), seq: f.num(), text: f.str() },
        scopes: { thread: ({ by: { chatId: 'chatId' } }) }
      });
      const { paged, ...pagination } = overrides;
      const shape =
        paged === false
          ? { select: (data: Response) => data.rows }
          : {
              page: (data: Response) => ({ nodes: data.rows, pageInfo: { hasNextPage: false, endCursor: null } }),
              ...(paged === true ? { coverage: 'complete' as const } : { coverage: 'page' as const })
            };
      return messages.query<Response, { chatId: string }, { chatId: string }, Row>('thread', {
        document,
        vars: scopeValue => ({ chatId: scopeValue.chatId }),
        into: messages.scopes.thread,
        staleTime: 60_000,
        ...shape,
        ...pagination
      });
    };

    const firstQuery = buildRuntime(base);
    await act(async () => {
      await bootDb();
    });
    const FirstReader = () => {
      firstQuery.use({ chatId: 'chat-1' });
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

    const secondQuery = buildRuntime(changed);
    await act(async () => {
      await bootDb();
    });
    const SecondReader = () => {
      secondQuery.use({ chatId: 'chat-1' });
      return null;
    };
    let secondRoot!: TestRenderer.ReactTestRenderer;
    act(() => {
      secondRoot = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(SecondReader)));
    });
    await act(async () => {
      await settle();
    });

    // The old record must not satisfy the changed declaration: the reader goes back to the network.
    expect(calls).toBe(2);
    act(() => secondRoot.unmount());
  });
});

/**
 * Persistence window rules: only a finite positive freshness window writes a durable query record;
 * an empty result falls back through the declared empty-window chain. The finite-window baseline
 * lives in the round-trip test above.
 */
describe('persistence window rules', () => {
  let windowSeq = 0;
  const landOnce = async (staleTime: number | undefined, rows: Row[], defaults?: { emptyStaleTime?: number }) => {
    const storage = createMemoryPlane();
    let calls = 0;
    const respond = <TData,>(): Promise<{ data: TData }> => {
      calls += 1;
      return Promise.resolve({ data: { rows } as TData });
    };
    const modelId = `SpecWindow${++windowSeq}`;
    const buildRuntime = () => {
      configureDb({ storage, transport: createMockTransport({ query: respond }), ...(defaults ? { defaults } : {}) });
      const messages = defineModelRuntime({
        id: modelId,
        name: modelId,
        fields: { chatId: f.str(), seq: f.num(), text: f.str() },
        scopes: { thread: ({ by: { chatId: 'chatId' } }) }
      });
      return messages.query<Response, { chatId: string }, { chatId: string }, Row>('thread', {
        document,
        vars: scopeValue => ({ chatId: scopeValue.chatId }),
        select: data => data.rows,
        into: messages.scopes.thread,
        coverage: 'complete',
        ...(staleTime === undefined ? {} : { staleTime })
      });
    };
    const query = buildRuntime();
    await act(async () => {
      await bootDb();
    });
    const Reader = () => {
      query.use({ chatId: 'chat-1' });
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await act(async () => {
      await settle();
    });
    expect(calls).toBe(1);
    act(() => root.unmount());
    return { storage, buildRuntime, callCount: () => calls };
  };
  const queryRecordKeys = (storage: { snapshotKeys: () => string[] }): string[] => storage.snapshotKeys().filter(key => key.startsWith('dbl:query'));

  it('writes no durable record for an infinite freshness window', async () => {
    const { storage } = await landOnce(Infinity, [{ id: 'm-1', chatId: 'chat-1', seq: 1, text: 'kept in memory' }]);
    expect(queryRecordKeys(storage)).toEqual([]);
  });

  it('writes no durable record for a zero freshness window', async () => {
    const { storage } = await landOnce(0, [{ id: 'm-1', chatId: 'chat-1', seq: 1, text: 'never fresh' }]);
    expect(queryRecordKeys(storage)).toEqual([]);
  });

  it('persists an empty result under the default empty window and restores it without a refetch', async () => {
    const { storage, buildRuntime, callCount } = await landOnce(undefined, [], { emptyStaleTime: 60_000 });
    expect(queryRecordKeys(storage)).toHaveLength(1);

    const secondQuery = buildRuntime();
    await act(async () => {
      await bootDb();
    });
    const Reader = () => {
      secondQuery.use({ chatId: 'chat-1' });
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await act(async () => {
      await settle();
    });

    // The restored empty chain is fresh inside the empty window: no second network call.
    expect(callCount()).toBe(1);
    act(() => root.unmount());
  });
});
