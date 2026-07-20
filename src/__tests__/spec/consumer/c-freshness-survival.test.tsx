import React from 'react';
import { AppState } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { DbProvider, configureDb, defineFetch, defineModel, f, resetRuntime, scope } from '../../../index';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

type Row = { id: string; name: string; group: string | null };
type Response = { rows: Row[] };
type FetchResponse = { value: string };

const document = { kind: 'Document', definitions: [] } as never;

const settle = async () => {
  for (let tick = 0; tick < 6; tick += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

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
    expect(rows.get('row-2')).toBeTruthy();
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
    expect(rows.get('b')).toBeTruthy();
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
    act(() => rows.insertStored({ id: 'seeded', name: 'Seeded', group: null }));
    act(() => root.update(React.createElement(Root, { mounted: true })));
    await settle();

    expect(calls).toBe(2);
    expect(rows.get('server-2')).toBeTruthy();
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
    expect(calls).toBe(2);
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
});
