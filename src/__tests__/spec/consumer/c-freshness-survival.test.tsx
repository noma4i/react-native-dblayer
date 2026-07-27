import React from 'react';
import { AppState } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { DbProvider, configureDb, defineFetch, defineModel, f, resetRuntime, scope } from '../../../index';
import { createMemoryPlane, createMockTransport, settle } from '../helpers/harness';

type Row = { id: string; name: string; group: string | null };
type Response = { rows: Row[] };
type FetchResponse = { value: string };

const document = { kind: 'Document', definitions: [] } as never;

const createRowsModel = (id: string) =>
  defineModel({
    id,
    name: id,
    fields: { name: f.str(), group: f.str().nullable() },
    scopes: { group: scope<Row>({ by: { group: 'group' } }) }
  });

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

  it('refetches an Infinity-fresh detail query on remount after its committed row was destroyed', async () => {
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

  it('stays fresh on remount while at least one committed row survives', async () => {
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
    const rows = createRowsModel('FreshnessPartialSurvival');
    const query = rows.query<Response, void, void, Row>('list', { document, key: 'freshness-partial-survival', select: data => data.rows, staleTime: Infinity });
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
    act(() => rows.destroy('a'));
    act(() => root.update(React.createElement(Root, { mounted: false })));
    act(() => root.update(React.createElement(Root, { mounted: true })));
    await settle();

    expect(calls).toBe(1);
    expect(rows.find('b')).toBeTruthy();
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

  it('invalidates db queries older than resumeStaleTime on foreground resume', async () => {
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
    const fetch = defineFetch<FetchResponse, void, string>({ document, key: 'freshness-fetch-resume', select: data => data.value, staleTime: Infinity });
    const Reader = () => {
      fetch.use(undefined);
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
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never, defaults: { resumeStaleTime: 1000 } });
    const exempt = defineFetch<{ value: string }, void, string>({ key: 'freshness-resume-exempt', fetcher: async () => ({ value: String(++exemptCalls) }), select: data => data.value, staleTime: Infinity, resumeStaleTime: null });
    const inherited = defineFetch<{ value: string }, void, string>({ key: 'freshness-resume-inherited', fetcher: async () => ({ value: String(++inheritedCalls) }), select: data => data.value, staleTime: Infinity });
    const Reader = () => {
      exempt.use(undefined);
      inherited.use(undefined);
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
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never, defaults: { resumeStaleTime: 50, resumeRefetch: { chunkSize: 2 } } });
    const fetches = Array.from({ length: 5 }, (_, index) =>
      defineFetch<{ value: string }, void, string>({
        key: `freshness-resume-chunk-${index}`,
        fetcher: async () => {
          calls.push(index);
          if (!resuming) return { value: String(index) };
          return new Promise(resolve => releaseRefetches.push(() => resolve({ value: String(index) })));
        },
        select: data => data.value,
        staleTime: Infinity
      })
    );
    const Reader = () => {
      for (const fetch of fetches) fetch.use(undefined);
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
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never, defaults: { resumeStaleTime: 50, resumeRefetch: { chunkSize: 2 } } });
    const fetches = Array.from({ length: 4 }, (_, index) =>
      defineFetch<{ value: string }, void, string>({
        key: `freshness-resume-cancel-${index}`,
        fetcher: async () => {
          calls.push(index);
          if (!resuming) return { value: String(index) };
          return new Promise(resolve => releaseRefetches.push(() => resolve({ value: String(index) })));
        },
        select: data => data.value,
        staleTime: Infinity
      })
    );
    const Reader = () => {
      for (const fetch of fetches) fetch.use(undefined);
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
