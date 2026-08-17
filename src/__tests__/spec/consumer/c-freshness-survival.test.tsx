import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import React, { act } from 'react';
import { AppState } from 'react-native';
import TestRenderer from 'react-test-renderer';
import { DbProvider, bootDb, compositeKey, configureDb, createCommitEnvelope, defineModel, defineModelRuntime, defineShape, f, getApplyRuntime, getDbQueryClient, getInternalModelHandle, resetRuntime, type QueryPersistenceRecord } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics, settle } from '../helpers/harness';

type Row = { id: string; name: string; group: string | null };
type Response = { rows: Row[] };
type ValueData = { value: string };
type ValueVariables = { index: number };
type ValueRow = { id: string; value: string };
type ForeignData = { ids: string[] };
type ForeignRow = { id: string; ids: string[] };
type EmptyVariables = Record<string, never>;
type ValueRelationOptions = { staleTime?: number | string; resumeStaleTime?: number | null };

const document = { kind: 'Document', definitions: [] } as never;
const rowsDocument: TypedDocumentNode<Response, Record<string, never>> = { kind: Kind.DOCUMENT, definitions: [] };
const valueDocument: TypedDocumentNode<ValueData, ValueVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const foreignDocument: TypedDocumentNode<ForeignData, EmptyVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const ValueSchema = defineShape<ValueRow>()({ value: f.str() });
const ForeignSchema = defineShape<ForeignRow>()({ ids: f.array(f.str()) });
const RowSchema = defineShape<Row>()({ name: f.str(), group: f.str().nullable() });

const createValueRelation = (key: string, transportValueKey = 0, options: ValueRelationOptions = {}) => {
  const Model = defineModel(key, {
    schema: ValueSchema,
    relations: owner => ({
      result: {
        remote: owner.gql.single(valueDocument, {
          variables: (params: ValueVariables) => params,
          select: data => ({ id: key, value: data.value }),
          ...options
        })
      }
    })
  });
  return Model.result({ index: transportValueKey });
};

const createRowsModel = (id: string) =>
  defineModelRuntime({
    id,
    name: id,
    fields: { name: f.str(), group: f.str().nullable() },
    scopes: { group: ({ by: { group: 'group' } }) }
  });

const createDurableRowsModel = () =>
  defineModel('FreshnessDurableRewrite', {
    schema: RowSchema,
    relations: owner => ({
      detail: {
        remote: owner.gql.list(rowsDocument, {
          variables: () => ({}),
          select: data => data.rows,
          staleTime: 1_000
        })
      }
    })
  });

const readOnlyQueryRecord = (storage: ReturnType<typeof createMemoryPlane>): QueryPersistenceRecord<{ ids: string[] }> => {
  const key = storage.snapshotKeys().find(candidate => candidate.startsWith('dbl:query:'));
  if (key === undefined) throw new Error('query record is missing');
  const envelope = JSON.parse(storage.get(key)!) as { payload: QueryPersistenceRecord<{ ids: string[] }> };
  return envelope.payload;
};

describe('freshness follows committed-row survival and foreground resume', () => {
  let appStateHandler: ((state: string) => void) | undefined;

  beforeEach(() => {
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_event: string, handler: (state: string) => void) => {
      appStateHandler = handler;
      return { remove: jest.fn() };
    }) as never);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('stops a foreground resume drain at reset and the reset runtime serves fresh landings', async () => {
    jest.useFakeTimers();
    const indexCalls: number[] = [];
    const perIndexServed = new Map<number, number>();
    const releaseRefetches: Array<() => void> = [];
    let resuming = false;
    const transport = createMockTransport({
      query: async <TData, TVariables>(operation: { variables?: TVariables }) => {
        const index = (operation.variables as unknown as ValueVariables).index;
        indexCalls.push(index);
        const nth = (perIndexServed.get(index) ?? 0) + 1;
        perIndexServed.set(index, nth);
        if (!resuming) return { data: { value: `v${index}-${nth}` } as TData };
        return new Promise<{ data: TData }>(resolve => releaseRefetches.push(() => resolve({ data: { value: `v${index}-${nth}` } as TData })));
      }
    });
    configureDb({ storage: createMemoryPlane(), transport, defaults: { resumeStaleTime: 50, resumeRefetch: { chunkSize: 1 } } });
    const first = createValueRelation('FreshnessResetDrainFirst', 0, { staleTime: Infinity });
    const second = createValueRelation('FreshnessResetDrainSecond', 1, { staleTime: Infinity });
    const observed: Array<string | undefined> = [undefined, undefined];
    const Reader = () => {
      observed[0] = first.use().data?.value;
      observed[1] = second.use().data?.value;
      return null;
    };
    const Root = ({ mounted }: { mounted: boolean }) => React.createElement(DbProvider, null, mounted ? React.createElement(Reader) : null);
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(Root, { mounted: true }));
    });
    await settle();
    expect(observed).toEqual(['v0-1', 'v1-1']);
    expect(indexCalls).toEqual([0, 1]);

    resuming = true;
    act(() => {
      jest.advanceTimersByTime(51);
      appStateHandler?.('background');
      appStateHandler?.('active');
    });
    await settle();
    // chunkSize 1: only the first stale query is refetching when the reset lands.
    expect(indexCalls).toEqual([0, 1, 0]);

    resuming = false;
    act(() => resetRuntime());
    await settle();
    // The reset wake-up refetches both mounted readers from the new generation and serves fresh
    // values; the reset also zeroes the resume diagnostics (companion).
    expect(indexCalls).toEqual([0, 1, 0, 0, 1]);
    expect(observed).toEqual(['v0-3', 'v1-2']);
    expect(diagnostics().snapshot()).toMatchObject({ resumeDrains: 0, resumeRefetches: 0 });

    // Releasing the stalled resume refetch neither dispatches a second drain chunk nor
    // overwrites the fresh post-reset values with the stale landing.
    act(() => {
      releaseRefetches.splice(0).forEach(release => release());
    });
    await settle();
    expect(indexCalls).toEqual([0, 1, 0, 0, 1]);
    expect(observed).toEqual(['v0-3', 'v1-2']);
    act(() => root.unmount());
  });

  it('honors defaults.refetchOnMount=false for query remounts with fetched stale data', async () => {
    let calls = 0;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        query: async <TData,>() => {
          calls += 1;
          return { data: { rows: [{ id: 'row-1', name: 'Cached', group: null }] } as TData };
        }
      }),
      defaults: { refetchOnMount: false }
    });
    const rows = createRowsModel('FreshnessQueryMountDefault');
    const query = rows.query<Response, void, void, Row>('detail', { document, key: 'freshness-query-mount-default', select: data => data.rows, staleTime: 0 });
    const Reader = () => {
      query.use(undefined);
      return null;
    };
    const Root = ({ mounted }: { mounted: boolean }) => React.createElement(DbProvider, null, mounted ? React.createElement(Reader) : null);
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(Root, { mounted: true }));
    });
    await settle();
    expect(calls).toBe(1);

    act(() => root.update(React.createElement(Root, { mounted: false })));
    act(() => root.update(React.createElement(Root, { mounted: true })));
    await settle();

    expect(calls).toBe(1);
    act(() => root.unmount());
  });

  it('[F3] refetches an Infinity-fresh detail query on remount after its committed row was destroyed', async () => {
    let calls = 0;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ query: async <TData,>() => ({ data: { rows: [{ id: `row-${++calls}`, name: 'Materialized', group: null }] } as TData }) })
    });
    const rows = createRowsModel('FreshnessDetailRemount');
    const query = rows.query<Response, void, void, Row>('detail', { document, key: 'freshness-detail-remount', select: data => data.rows, staleTime: Infinity });
    const Reader = () => {
      query.use(undefined);
      return null;
    };
    const Root = ({ mounted }: { mounted: boolean }) => React.createElement(DbProvider, null, mounted ? React.createElement(Reader) : null);
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(Root, { mounted: true }));
    });
    await settle();
    act(() => rows.destroy('row-1'));
    act(() => root.update(React.createElement(Root, { mounted: false })));
    act(() => root.update(React.createElement(Root, { mounted: true })));
    await settle();

    expect(calls).toBe(2);
    expect(rows.find('row-2')).toBeTruthy();
    act(() => root.unmount());
  });

  it('[F17] rewrites only the swapped id of a multi-row chain and keeps the rest in place', async () => {
    let calls = 0;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        query: async <TData,>() => {
          calls += 1;
          return { data: { rows: [{ id: 'row-1', name: 'First', group: null }, { id: 'row-2', name: 'Second', group: null }] } as TData };
        }
      })
    });
    const rows = createRowsModel('FreshnessReplacePartial');
    const query = rows.query<Response, void, void, Row>('detail', { document, key: 'freshness-replace-partial', select: data => data.rows, staleTime: Infinity });
    const Reader = () => {
      query.use(undefined);
      return null;
    };
    const Root = ({ mounted }: { mounted: boolean }) => React.createElement(DbProvider, null, mounted ? React.createElement(Reader) : null);
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(Root, { mounted: true }));
    });
    await settle();
    expect(calls).toBe(1);
    // Swap ONE of the two chain rows: the untouched sibling must anchor nothing - the chain
    // rewrites only the swapped identity and stays fresh.
    act(() => {
      getApplyRuntime().commit(createCommitEnvelope(getInternalModelHandle(rows).planReplace('row-1', { id: 'server-1', name: 'First', group: null })));
    });
    await settle();
    act(() => root.update(React.createElement(Root, { mounted: false })));
    act(() => root.update(React.createElement(Root, { mounted: true })));
    await settle();

    expect(calls).toBe(1);
    expect(rows.find('server-1')).toBeTruthy();
    expect(rows.find('row-2')).toBeTruthy();
    // The rewritten chain now anchors on the successor: destroying the untouched sibling must
    // shrink the chain to the survivor - a chain that still held the dead old id would go empty
    // and refetch immediately without counting a survivor shrink.
    const shrinksBefore = diagnostics().snapshot().chainSurvivorShrinks;
    act(() => rows.destroy('row-2'));
    await settle();
    expect(diagnostics().snapshot().chainSurvivorShrinks).toBe(shrinksBefore + 1);
    expect(calls).toBe(1);
    act(() => root.unmount());
  });

  it('[F17] [W35] keeps the freshness chain intact through an identity replace without new transport', async () => {
    let calls = 0;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ query: async <TData,>() => { calls += 1; return { data: { rows: [{ id: 'row-1', name: 'Materialized', group: null }] } as TData }; } })
    });
    const rows = createRowsModel('FreshnessReplaceIdentity');
    const query = rows.query<Response, void, void, Row>('detail', { document, key: 'freshness-replace-identity', select: data => data.rows, staleTime: Infinity });
    const Reader = () => {
      query.use(undefined);
      return null;
    };
    const Root = ({ mounted }: { mounted: boolean }) => React.createElement(DbProvider, null, mounted ? React.createElement(Reader) : null);
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(Root, { mounted: true }));
    });
    await settle();
    expect(calls).toBe(1);
    act(() => {
      getApplyRuntime().commit(createCommitEnvelope(getInternalModelHandle(rows).planReplace('row-1', { id: 'server-1', name: 'Materialized', group: null })));
    });
    await settle();
    act(() => root.update(React.createElement(Root, { mounted: false })));
    act(() => root.update(React.createElement(Root, { mounted: true })));
    await settle();

    expect(calls).toBe(1);
    expect(rows.find('server-1')).toBeTruthy();
    act(() => root.unmount());
  });

  it('leaves a non-chain cached result untouched when its ids-shaped payload matches destroyed rows', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        query: async <TData,>() => ({ data: { ids: [compositeKey('FreshnessForeignIds', 'row-1')] } as TData })
      })
    });
    const rows = createRowsModel('FreshnessForeignIds');
    const foreignId = compositeKey('FreshnessForeignIds', 'row-1');
    const Foreign = defineModel('FreshnessForeignIdsResult', {
      schema: ForeignSchema,
      relations: owner => ({
        result: {
          remote: owner.gql.single(foreignDocument, {
            variables: (_params: EmptyVariables) => ({}),
            select: data => ({ id: 'foreign-result', ids: data.ids }),
            staleTime: Infinity
          })
        }
      })
    });
    const relation = Foreign.result({});
    let observed: { ids: string[] } | undefined;
    const Reader = () => {
      const row = relation.use().data;
      observed = row === undefined ? undefined : { ids: row.ids };
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await settle();
    act(() => rows.seed([{ id: 'row-1', name: 'Foreign', group: null }]));
    await settle();
    expect(observed).toEqual({ ids: [foreignId] });

    act(() => rows.destroy('row-1'));
    await settle();

    expect(observed).toEqual({ ids: [foreignId] });
    act(() => root.unmount());
  });

  it('[F40] stales a partially emptied chain and counts the survivor shrink', async () => {
    let calls = 0;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        query: async <TData,>() => {
          calls += 1;
          return { data: { rows: ['a', 'b', 'c'].map(id => ({ id, name: id, group: null })) } as TData };
        }
      })
    });
    const rows = createRowsModel('FreshnessPartialShrink');
    const query = rows.query<Response, void, void, Row>('list', { document, key: 'freshness-partial-shrink', select: data => data.rows, staleTime: Infinity });
    const Reader = () => {
      query.use(undefined);
      return null;
    };
    const Root = ({ mounted }: { mounted: boolean }) => React.createElement(DbProvider, null, mounted ? React.createElement(Reader) : null);
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(Root, { mounted: true }));
    });
    await settle();
    expect(calls).toBe(1);
    const shrinksBefore = diagnostics().snapshot().chainSurvivorShrinks;
    act(() => rows.destroy('a'));
    await settle();

    expect(diagnostics().snapshot().chainSurvivorShrinks).toBe(shrinksBefore + 1);
    expect(rows.find('b')).toBeTruthy();
    // The reduced result lost its freshness stamp: a remount refetches instead of trusting it.
    act(() => root.update(React.createElement(Root, { mounted: false })));
    act(() => root.update(React.createElement(Root, { mounted: true })));
    await settle();
    expect(calls).toBe(2);
    act(() => root.unmount());
  });

  it('[F41] re-judges a loss skipped mid-fetch after that fetch fails', async () => {
    jest.useFakeTimers();
    let calls = 0;
    let failNext = false;
    const rejects: Array<(error: Error) => void> = [];
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        query: async <TData,>() => {
          calls += 1;
          if (failNext) return new Promise<{ data: TData }>((_resolve, reject) => rejects.push(reject));
          if (calls === 1) return { data: { rows: [{ id: 'kept', name: 'Kept', group: null }, { id: 'doomed', name: 'Doomed', group: null }] } as TData };
          return { data: { rows: [{ id: 'kept', name: 'Kept', group: null }, { id: 'refetched', name: 'Refetched', group: null }] } as TData };
        }
      }),
      defaults: { resumeStaleTime: 50 }
    });
    const rows = createRowsModel('FreshnessRejudgeFailedFetch');
    const query = rows.query<Response, void, void, Row>('list', { document, key: 'freshness-rejudge-failed-fetch', select: data => data.rows, staleTime: Infinity });
    let observedIds: string[] = [];
    const Reader = () => {
      const raw: unknown = query.use(undefined).data;
      observedIds = Array.isArray(raw) ? (raw as Row[]).map(row => row.id) : [];
      return null;
    };
    const Root = ({ mounted }: { mounted: boolean }) => React.createElement(DbProvider, null, mounted ? React.createElement(Reader) : null);
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(Root, { mounted: true }));
    });
    await settle();
    expect(calls).toBe(1);
    expect(observedIds).toEqual(['kept', 'doomed']);
    const shrinksBefore = diagnostics().snapshot().chainSurvivorShrinks;
    failNext = true;
    act(() => {
      jest.advanceTimersByTime(51);
      appStateHandler?.('background');
      appStateHandler?.('active');
    });
    await settle();
    expect(calls).toBe(2);
    // Loss lands while the refetch is in flight: the reader serves the survivor and the
    // judgment is deferred, not dropped (companion counter unchanged).
    act(() => rows.destroy('doomed'));
    await settle();
    expect(observedIds).toEqual(['kept']);
    expect(diagnostics().snapshot().chainSurvivorShrinks).toBe(shrinksBefore);

    act(() => {
      rejects.splice(0).forEach(reject => reject(new Error('network down')));
    });
    await settle();
    expect(diagnostics().snapshot().chainSurvivorShrinks).toBe(shrinksBefore + 1);
    // The re-judged loss stales the chain: a remount fetches again and serves the full landing.
    failNext = false;
    act(() => root.update(React.createElement(Root, { mounted: false })));
    act(() => root.update(React.createElement(Root, { mounted: true })));
    await settle();
    expect(calls).toBe(3);
    // The destroyed id stays tombstoned; the refetch lands and serves the fresh replacement row.
    expect(observedIds).toEqual(['kept', 'refetched']);
    act(() => root.unmount());
  });

  it('[F42] keeps the deferred judgment when unrelated cache events land before the failed settle', async () => {
    jest.useFakeTimers();
    let calls = 0;
    let failNext = false;
    const rejects: Array<(error: Error) => void> = [];
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        query: async <TData,>() => {
          calls += 1;
          if (failNext) return new Promise<{ data: TData }>((_resolve, reject) => rejects.push(reject));
          if (calls === 1) return { data: { rows: [{ id: 'kept', name: 'Kept', group: null }, { id: 'doomed', name: 'Doomed', group: null }] } as TData };
          return { data: { rows: [{ id: 'kept', name: 'Kept', group: null }, { id: 'refetched', name: 'Refetched', group: null }] } as TData };
        }
      }),
      defaults: { resumeStaleTime: 50, retry: { query: { classify: () => 'network', budgets: { network: 1 }, backoff: { baseMs: 10, maxMs: 100 } } } }
    });
    const rows = createRowsModel('FreshnessRejudgeObserverNoise');
    const query = rows.query<Response, void, void, Row>('list', { document, key: 'freshness-rejudge-observer-noise', select: data => data.rows, staleTime: Infinity });
    let observedIds: string[] = [];
    const Reader = () => {
      const raw: unknown = query.use(undefined).data;
      observedIds = Array.isArray(raw) ? (raw as Row[]).map(row => row.id) : [];
      return null;
    };
    const Root = ({ readers }: { readers: number }) =>
      React.createElement(DbProvider, null, Array.from({ length: readers }, (_unused, index) => React.createElement(Reader, { key: index })));
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(Root, { readers: 1 }));
    });
    await settle();
    expect(calls).toBe(1);
    expect(observedIds).toEqual(['kept', 'doomed']);
    const shrinksBefore = diagnostics().snapshot().chainSurvivorShrinks;
    failNext = true;
    act(() => {
      jest.advanceTimersByTime(51);
      appStateHandler?.('background');
      appStateHandler?.('active');
    });
    await settle();
    expect(calls).toBe(2);
    act(() => rows.destroy('doomed'));
    await settle();
    expect(observedIds).toEqual(['kept']);
    // Unrelated cache events land on the judged key before the failed settle: the first
    // attempt's failure updates the cache while its retry is still owed, and a second observer
    // mounts. Consuming the deferred judgment on either would drop the recorded loss unjudged.
    act(() => {
      rejects.splice(0).forEach(reject => reject(new Error('network down')));
    });
    await settle();
    act(() => root.update(React.createElement(Root, { readers: 2 })));
    await settle();
    expect(observedIds).toEqual(['kept']);
    expect(calls).toBe(2);
    expect(diagnostics().snapshot().chainSurvivorShrinks).toBe(shrinksBefore);

    // The retry dispatches, fails past its budget, and only THIS settle consumes the judgment.
    act(() => jest.advanceTimersByTime(25));
    await settle();
    expect(calls).toBe(3);
    act(() => {
      rejects.splice(0).forEach(reject => reject(new Error('network down')));
    });
    await settle();
    expect(diagnostics().snapshot().chainSurvivorShrinks).toBe(shrinksBefore + 1);
    // The judged loss stales the chain: a remount fetches again and serves the full landing.
    failNext = false;
    act(() => root.update(React.createElement(Root, { readers: 0 })));
    act(() => root.update(React.createElement(Root, { readers: 1 })));
    await settle();
    expect(calls).toBe(4);
    // The destroyed id stays tombstoned; the refetch lands and serves the fresh replacement row.
    expect(observedIds).toEqual(['kept', 'refetched']);
    act(() => root.unmount());
  });

  it('[F43] follows both deferred identity swaps without clearing the failed refresh invalidation', async () => {
    jest.useFakeTimers();
    let calls = 0;
    let failNext = false;
    const rejects: Array<(error: Error) => void> = [];
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        query: async <TData,>() => {
          calls += 1;
          if (failNext) return new Promise<{ data: TData }>((_resolve, reject) => rejects.push(reject));
          return { data: { rows: [{ id: 'a', name: 'A', group: null }, { id: 'b', name: 'B', group: null }] } as TData };
        }
      }),
      defaults: { resumeStaleTime: 50 }
    });
    const rows = createRowsModel('FreshnessRejudgeSwapMerge');
    const query = rows.query<Response, void, void, Row>('list', { document, key: 'freshness-rejudge-swap-merge', select: data => data.rows, staleTime: Infinity });
    let observedIds: string[] = [];
    const Reader = () => {
      const raw: unknown = query.use(undefined).data;
      observedIds = Array.isArray(raw) ? (raw as Row[]).map(row => row.id) : [];
      return null;
    };
    const Root = ({ mounted }: { mounted: boolean }) => React.createElement(DbProvider, null, mounted ? React.createElement(Reader) : null);
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(Root, { mounted: true }));
    });
    await settle();
    expect(calls).toBe(1);
    const shrinksBefore = diagnostics().snapshot().chainSurvivorShrinks;
    failNext = true;
    act(() => {
      jest.advanceTimersByTime(51);
      appStateHandler?.('background');
      appStateHandler?.('active');
    });
    await settle();
    expect(calls).toBe(2);
    // Two landing swaps arrive while the refetch is in flight: their successor map must merge
    // into the ONE deferred judgment instead of the second swap overwriting or dropping the first.
    act(() => {
      getApplyRuntime().commit(createCommitEnvelope(getInternalModelHandle(rows).planReplace('a', { id: 'srv-a', name: 'A', group: null })));
    });
    await settle();
    act(() => {
      getApplyRuntime().commit(createCommitEnvelope(getInternalModelHandle(rows).planReplace('b', { id: 'srv-b', name: 'B', group: null })));
    });
    await settle();
    act(() => {
      rejects.splice(0).forEach(reject => reject(new Error('network down')));
    });
    await settle();

    // A full-length identity rewrite is not a new loss, so it causes no immediate follow-up.
    // The failed refresh invalidation remains and starts a refetch when the reader remounts.
    expect(diagnostics().snapshot().chainSurvivorShrinks).toBe(shrinksBefore);
    expect(calls).toBe(2);
    act(() => root.update(React.createElement(Root, { mounted: false })));
    act(() => root.update(React.createElement(Root, { mounted: true })));
    await settle();
    expect(calls).toBe(3);
    expect([...observedIds].sort()).toEqual(['srv-a', 'srv-b']);
    act(() => root.unmount());
  });

  it('[F56] keeps the original freshness stamp through a full-length identity rewrite', async () => {
    jest.useFakeTimers();
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        query: async <TData,>() => ({ data: { rows: [{ id: 'row-1', name: 'First', group: null }] } as TData })
      })
    });
    const rows = createRowsModel('FreshnessRewriteStamp');
    const query = rows.query<Response, void, void, Row>('detail', { document, key: 'freshness-rewrite-stamp', select: data => data.rows, staleTime: Infinity });
    const stampOf = (): number => {
      const states = getDbQueryClient()
        .getQueryCache()
        .getAll()
        .map(cached => cached.state.dataUpdatedAt)
        .filter(stamp => stamp > 0);
      expect(states).toHaveLength(1);
      return states[0]!;
    };
    const Reader = () => {
      query.use(undefined);
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await settle();
    const landedStamp = stampOf();

    // The swap lands 50ms later: rewriting the chain onto the successor must NOT restamp
    // freshness - a NOW stamp here would silently defer every schedule keyed to the landing.
    act(() => {
      jest.advanceTimersByTime(50);
    });
    act(() => {
      getApplyRuntime().commit(createCommitEnvelope(getInternalModelHandle(rows).planReplace('row-1', { id: 'server-1', name: 'First', group: null })));
    });
    await settle();

    expect(rows.find('server-1')).toBeTruthy();
    expect(stampOf()).toBe(landedStamp);
    act(() => root.unmount());
  });

  it('[F57] preserves durable invalidation through a full-length identity rewrite and restart', async () => {
    const storage = createMemoryPlane();
    const onSyncError = jest.fn();
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        const id = calls === 1 ? 'row-1' : 'server-1';
        return { data: { rows: [{ id, name: 'First', group: null }] } as TData };
      }
    });
    configureDb({ storage, transport, defaults: { onSyncError } });
    const rows = createDurableRowsModel();
    const query = rows.detail({});
    const Reader = () => {
      query.use(undefined);
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await settle();
    expect(calls).toBe(1);
    act(() => root.unmount());
    const originalStamp = readOnlyQueryRecord(storage).dataUpdatedAt;

    query.invalidate();
    expect(getDbQueryClient().getQueryCache().getAll()[0]!.state.isInvalidated).toBe(true);
    const invalidateQueries = jest.spyOn(getDbQueryClient(), 'invalidateQueries');
    act(() => {
      getApplyRuntime().commit(createCommitEnvelope(getInternalModelHandle(rows).planReplace('row-1', { id: 'server-1', name: 'First', group: null })));
    });
    await settle();

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: expect.any(Array), exact: true, refetchType: 'none' });
    expect(getDbQueryClient().getQueryCache().getAll()[0]!.state).toMatchObject({ dataUpdatedAt: originalStamp, isInvalidated: true });
    expect(readOnlyQueryRecord(storage)).toMatchObject({
      payload: { ids: [compositeKey('FreshnessDurableRewrite', 'server-1')] },
      empty: false,
      dataUpdatedAt: originalStamp,
      invalidated: true
    });

    configureDb({ storage, transport, defaults: { onSyncError } });
    const restartedRows = createDurableRowsModel();
    const restartedQuery = restartedRows.detail({});
    await bootDb();
    const RestartedReader = () => {
      restartedQuery.use(undefined);
      return null;
    };
    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(RestartedReader)));
    });
    await settle();

    expect(calls).toBe(2);
    expect(restartedRows.find('server-1')).toBeTruthy();
    expect(onSyncError).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('[F45] survives a loss touch on a chain that never landed data', async () => {
    let calls = 0;
    let failing = true;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        query: async <TData,>(): Promise<{ data: TData }> => {
          calls += 1;
          if (failing) throw new Error('transport down');
          return { data: { rows: [{ id: 'landed-1', name: 'Landed', group: null }, { id: 'landed-2', name: 'Landed', group: null }] } as TData };
        }
      })
    });
    const rows = createRowsModel('FreshnessJudgeNoMeta');
    const query = rows.query<Response, void, void, Row>('list', { document, key: 'freshness-judge-no-meta', select: data => data.rows, staleTime: Infinity });
    let observedIds: string[] | undefined;
    const Reader = () => {
      const raw: unknown = query.use(undefined).data;
      observedIds = Array.isArray(raw) ? (raw as Row[]).map(row => row.id) : undefined;
      return null;
    };
    const Root = ({ mounted }: { mounted: boolean }) => React.createElement(DbProvider, null, mounted ? React.createElement(Reader) : null);
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(Root, { mounted: true }));
    });
    await settle(4);
    expect(observedIds).toBeUndefined();

    // The chain is registered but never landed: touches on it are judged as a no-op, not a crash.
    act(() => rows.seed([{ id: 'x', name: 'X', group: null }]));
    await settle();
    act(() => rows.destroy('x'));
    await settle();
    expect(rows.find('x')).toBeUndefined();
    expect(diagnostics().snapshot().chainSurvivorShrinks).toBe(0);

    // The runtime survived the touch: the next successful landing serves rows to a remounted reader.
    failing = false;
    const callsBeforeRemount = calls;
    act(() => root.update(React.createElement(Root, { mounted: false })));
    act(() => root.update(React.createElement(Root, { mounted: true })));
    await settle();
    expect(calls).toBe(callsBeforeRemount + 1);
    expect(observedIds).toEqual(['landed-1', 'landed-2']);

    // Positive counterpart: once the chain HAS landed data, the same loss touch counts a shrink
    // and the reader serves the survivor.
    act(() => rows.destroy('landed-1'));
    await settle();
    expect(observedIds).toEqual(['landed-2']);
    expect(diagnostics().snapshot().chainSurvivorShrinks).toBe(1);
    act(() => root.unmount());
  });

  it('keeps emptyStaleTime semantics for zero-row results', async () => {
    jest.useFakeTimers();
    let calls = 0;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        query: async <TData,>() => {
          calls += 1;
          return { data: { rows: [] } as TData };
        }
      })
    });
    const rows = createRowsModel('FreshnessEmptyWindow');
    const query = rows.query<Response, void, void, Row>('empty', { document, key: 'freshness-empty-window', select: data => data.rows, staleTime: Infinity, emptyStaleTime: 1000 });
    const Reader = () => {
      query.use(undefined);
      return null;
    };
    const Root = ({ mounted }: { mounted: boolean }) => React.createElement(DbProvider, null, mounted ? React.createElement(Reader) : null);
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(Root, { mounted: true }));
    });
    await settle();
    act(() => root.update(React.createElement(Root, { mounted: false })));
    act(() => root.update(React.createElement(Root, { mounted: true })));
    await settle();
    expect(calls).toBe(1);
    act(() => jest.advanceTimersByTime(1001));
    act(() => root.update(React.createElement(Root, { mounted: false })));
    act(() => root.update(React.createElement(Root, { mounted: true })));
    await settle();
    expect(calls).toBe(2);
    act(() => root.unmount());
  });

  it('clears survival records on resetRuntime', async () => {
    let calls = 0;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ query: async <TData,>() => ({ data: { rows: [{ id: `server-${++calls}`, name: 'Server', group: null }] } as TData }) })
    });
    const rows = createRowsModel('FreshnessReset');
    const query = rows.query<Response, void, void, Row>('reset', { document, key: 'freshness-reset', select: data => data.rows, staleTime: Infinity });
    const Reader = () => {
      query.use(undefined);
      return null;
    };
    const Root = ({ mounted }: { mounted: boolean }) => React.createElement(DbProvider, null, mounted ? React.createElement(Reader) : null);
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(Root, { mounted: true }));
    });
    await settle();
    act(() => root.update(React.createElement(Root, { mounted: false })));
    act(() => resetRuntime());
    act(() => rows.insert({ id: 'seeded', name: 'Seeded', group: null }));
    act(() => root.update(React.createElement(Root, { mounted: true })));
    await settle();

    expect(calls).toBe(2);
    expect(rows.find('server-2')).toBeTruthy();
    act(() => root.unmount());
  });

  it('scope-destination query goes vacuously stale when the scope empties', async () => {
    let calls = 0;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ query: async <TData,>() => ({ data: { rows: [{ id: `scope-${++calls}`, name: 'Scoped', group: 'g' }] } as TData }) })
    });
    const rows = createRowsModel('FreshnessScopeRemount');
    const query = rows.query<Response, { group: string }, { group: string }, Row>('group', {
      document,
      key: 'freshness-scope-remount',
      vars: value => value,
      select: data => data.rows,
      into: rows.scopes.group,
      staleTime: Infinity
    });
    const Reader = () => {
      query.use({ group: 'g' });
      return null;
    };
    const Root = ({ mounted }: { mounted: boolean }) => React.createElement(DbProvider, null, mounted ? React.createElement(Reader) : null);
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(Root, { mounted: true }));
    });
    await settle();
    act(() => rows.destroy('scope-1'));
    act(() => root.update(React.createElement(Root, { mounted: false })));
    act(() => root.update(React.createElement(Root, { mounted: true })));
    await settle();

    expect(calls).toBe(2);
    expect(rows.scopes.group.read({ group: 'g' }).map(row => row.id)).toEqual(['scope-2']);
    act(() => root.unmount());
  });

  it('invalidates old model queries on foreground resume and keeps the successful result fresh', async () => {
    jest.useFakeTimers();
    let calls = 0;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ query: async <TData,>() => ({ data: { rows: [{ id: 'resume', name: String(++calls), group: null }] } as TData }) }),
      defaults: { resumeStaleTime: 1000 }
    });
    const rows = createRowsModel('FreshnessResume');
    const query = rows.query<Response, void, void, Row>('resume', { document, key: 'freshness-resume', select: data => data.rows, staleTime: Infinity });
    const Reader = () => {
      query.use(undefined);
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await settle();
    act(() => {
      jest.advanceTimersByTime(1001);
      appStateHandler?.('background');
      appStateHandler?.('active');
    });
    await settle();
    expect(calls).toBe(2);
    act(() => {
      appStateHandler?.('background');
      appStateHandler?.('active');
    });
    await settle();
    expect(calls).toBe(2);
    act(() => {
      jest.advanceTimersByTime(1001);
      appStateHandler?.('background');
      appStateHandler?.('active');
    });
    await settle();
    expect(calls).toBe(3);
    act(() => root.unmount());
  });

  it('invalidates fetch queries older than resumeStaleTime on foreground resume', async () => {
    jest.useFakeTimers();
    let calls = 0;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ query: async <TData,>() => ({ data: { value: String(++calls) } as TData }) }),
      defaults: { resumeStaleTime: 1000 }
    });
    const relation = createValueRelation('FreshnessFetchResume', 0, { staleTime: Infinity });
    const Reader = () => {
      relation.use();
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await settle();
    act(() => {
      jest.advanceTimersByTime(1001);
      appStateHandler?.('background');
      appStateHandler?.('active');
    });
    await settle();
    expect(calls).toBe(2);
    act(() => {
      appStateHandler?.('background');
      appStateHandler?.('active');
    });
    await settle();
    expect(calls).toBe(2);
    act(() => root.unmount());
  });

  it('resumeStaleTime null disables resume invalidation', async () => {
    jest.useFakeTimers();
    let calls = 0;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ query: async <TData,>() => ({ data: { rows: [{ id: 'disabled', name: String(++calls), group: null }] } as TData }) }),
      defaults: { resumeStaleTime: null }
    });
    const rows = createRowsModel('FreshnessResumeDisabled');
    const query = rows.query<Response, void, void, Row>('disabled', { document, key: 'freshness-resume-disabled', select: data => data.rows, staleTime: Infinity });
    const Reader = () => {
      query.use(undefined);
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await settle();
    act(() => {
      jest.advanceTimersByTime(1001);
      appStateHandler?.('background');
      appStateHandler?.('active');
    });
    await settle();
    expect(calls).toBe(1);
    act(() => root.unmount());
  });

  it('exempts a query with resumeStaleTime null while invalidating a default-inheriting neighbor', async () => {
    jest.useFakeTimers();
    let exemptCalls = 0;
    let inheritedCalls = 0;
    const transport = createMockTransport({
      query: async <TData, TVariables>(operation: { variables?: TVariables }) => {
        const index = (operation.variables as unknown as ValueVariables).index;
        if (index === 0) exemptCalls += 1;
        if (index === 1) inheritedCalls += 1;
        return { data: { value: String(index) } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport, defaults: { resumeStaleTime: 1000 } });
    const exempt = createValueRelation('FreshnessResumeExempt', 0, { staleTime: Infinity, resumeStaleTime: null });
    const inherited = createValueRelation('FreshnessResumeInherited', 1, { staleTime: Infinity });
    const Reader = () => {
      exempt.use();
      inherited.use();
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await settle();
    act(() => {
      jest.advanceTimersByTime(1001);
      appStateHandler?.('background');
      appStateHandler?.('active');
    });
    await settle();

    expect(exemptCalls).toBe(1);
    expect(inheritedCalls).toBe(2);
    act(() => root.unmount());
  });

  it('uses a shorter per-query resumeStaleTime than the package default', async () => {
    jest.useFakeTimers();
    let calls = 0;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ query: async <TData,>() => ({ data: { rows: [{ id: 'shorter', name: String(++calls), group: null }] } as TData }) }),
      defaults: { resumeStaleTime: 100000 }
    });
    const rows = createRowsModel('FreshnessResumeShorter');
    const query = rows.query<Response, void, void, Row>('shorter', { document, key: 'freshness-resume-shorter', select: data => data.rows, staleTime: Infinity, resumeStaleTime: 50 });
    const Reader = () => {
      query.use(undefined);
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await settle();
    act(() => {
      jest.advanceTimersByTime(51);
      appStateHandler?.('background');
      appStateHandler?.('active');
    });
    await settle();

    expect(calls).toBe(2);
    act(() => root.unmount());
  });

  it('uses an explicit numeric resumeStaleTime when the package default is null', async () => {
    jest.useFakeTimers();
    let calls = 0;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ query: async <TData,>() => ({ data: { rows: [{ id: 'global-null', name: String(++calls), group: null }] } as TData }) }),
      defaults: { resumeStaleTime: null }
    });
    const rows = createRowsModel('FreshnessResumeGlobalNull');
    const query = rows.query<Response, void, void, Row>('global-null', { document, key: 'freshness-resume-global-null', select: data => data.rows, staleTime: Infinity, resumeStaleTime: 50 });
    const Reader = () => {
      query.use(undefined);
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await settle();
    act(() => {
      jest.advanceTimersByTime(51);
      appStateHandler?.('background');
      appStateHandler?.('active');
    });
    await settle();

    expect(calls).toBe(2);
    act(() => root.unmount());
  });

  it('refetches active stale queries in sequential resume chunks', async () => {
    jest.useFakeTimers();
    const calls: number[] = [];
    const releaseRefetches: Array<() => void> = [];
    let resuming = false;
    const transport = createMockTransport({
      query: async <TData, TVariables>(operation: { variables?: TVariables }) => {
        const index = (operation.variables as unknown as ValueVariables).index;
        calls.push(index);
        if (!resuming) return { data: { value: String(index) } as TData };
        return new Promise<{ data: TData }>(resolve => releaseRefetches.push(() => resolve({ data: { value: String(index) } as TData })));
      }
    });
    configureDb({ storage: createMemoryPlane(), transport, defaults: { resumeStaleTime: 50, resumeRefetch: { chunkSize: 2 } } });
    const relations = Array.from({ length: 5 }, (_, index) => createValueRelation(`FreshnessResumeChunk${index}`, index, { staleTime: Infinity }));
    const Reader = () => {
      for (const relation of relations) relation.use();
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await settle();
    resuming = true;
    act(() => {
      jest.advanceTimersByTime(51);
      appStateHandler?.('background');
      appStateHandler?.('active');
    });
    await settle();

    expect(calls).toEqual([0, 1, 2, 3, 4, 0, 1]);
    expect(releaseRefetches).toHaveLength(2);
    act(() => {
      releaseRefetches.splice(0).forEach(release => release());
    });
    await settle();
    expect(calls).toEqual([0, 1, 2, 3, 4, 0, 1, 2, 3]);
    expect(releaseRefetches).toHaveLength(2);
    act(() => {
      releaseRefetches.splice(0).forEach(release => release());
    });
    await settle();
    expect(calls).toEqual([0, 1, 2, 3, 4, 0, 1, 2, 3, 4]);
    expect(releaseRefetches).toHaveLength(1);
    act(() => {
      releaseRefetches.splice(0).forEach(release => release());
    });
    await settle();
    act(() => root.unmount());
  });

  it('stops the resume drain on background and leaves remaining queries stale for remount', async () => {
    jest.useFakeTimers();
    const calls: number[] = [];
    const releaseRefetches: Array<() => void> = [];
    let resuming = false;
    const transport = createMockTransport({
      query: async <TData, TVariables>(operation: { variables?: TVariables }) => {
        const index = (operation.variables as unknown as ValueVariables).index;
        calls.push(index);
        if (!resuming) return { data: { value: String(index) } as TData };
        return new Promise<{ data: TData }>(resolve => releaseRefetches.push(() => resolve({ data: { value: String(index) } as TData })));
      }
    });
    configureDb({ storage: createMemoryPlane(), transport, defaults: { resumeStaleTime: 50, resumeRefetch: { chunkSize: 2 } } });
    const relations = Array.from({ length: 4 }, (_, index) => createValueRelation(`FreshnessResumeCancel${index}`, index, { staleTime: Infinity }));
    const Reader = () => {
      for (const relation of relations) relation.use();
      return null;
    };
    const Root = ({ mounted }: { mounted: boolean }) => React.createElement(DbProvider, null, mounted ? React.createElement(Reader) : null);
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(Root, { mounted: true }));
    });
    await settle();
    resuming = true;
    act(() => {
      jest.advanceTimersByTime(51);
      appStateHandler?.('background');
      appStateHandler?.('active');
    });
    await settle();
    expect(calls).toEqual([0, 1, 2, 3, 0, 1]);
    act(() => appStateHandler?.('background'));
    act(() => {
      releaseRefetches.splice(0).forEach(release => release());
    });
    await settle();
    expect(calls).toEqual([0, 1, 2, 3, 0, 1]);
    act(() => root.update(React.createElement(Root, { mounted: false })));
    act(() => root.update(React.createElement(Root, { mounted: true })));
    await settle();
    expect(calls).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    act(() => root.unmount());
  });
});
