import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { DbProvider, configureDb, defineModel, f, scope } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type ScopeValue = { userId: string };
type MixedRow = { id: string; userId: string; status: string };
type MixedResponse = { moments: Array<{ id: string | number; userId: string | number; status: string }> };
type RaceRow = { id: string; userId: string; status: string };
type RaceResponse = { moments: RaceRow[] };
type PageResponse = { moments: { nodes: RaceRow[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
type NullableRow = { id: string; userId: string; rank?: number | null; note?: string | null };
type NullableResponse = { moments: Array<{ id: string; userId: string | number; rank?: number | null; note?: string | null }> };

type Deferred<T> = {
  resolve: (data: T) => void;
  reject: (error: Error) => void;
};

const document = { kind: 'Document', definitions: [] } as never;

const settle = async () => {
  for (let tick = 0; tick < 6; tick += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const renderCountedInProvider = <T,>(useHook: () => T) => {
  let value!: T;
  let root!: TestRenderer.ReactTestRenderer;

  const Reader = () => {
    value = useHook();
    return null;
  };

  act(() => {
    root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
  });

  return {
    result: () => value,
    unmount: () => act(() => root.unmount())
  };
};

const createMixedMoments = () =>
  defineModel({
    id: 'SpecTransportMixedMoment',
    name: 'SpecTransportMixedMoment',
    fields: {
      id: f.id(),
      userId: f.id(),
      status: f.str()
    },
    scopes: {
      byUser: scope<MixedRow>({ by: { userId: 'userId' } })
    }
  });

const createRaceMoments = () =>
  defineModel({
    id: 'SpecTransportRaceMoment',
    name: 'SpecTransportRaceMoment',
    fields: {
      id: f.id(),
      userId: f.id(),
      status: f.str()
    },
    scopes: {
      byUser: scope<RaceRow>({ by: { userId: 'userId' } })
    }
  });

const createNullableMoments = () =>
  defineModel({
    id: 'SpecTransportNullableMoment',
    name: 'SpecTransportNullableMoment',
    fields: {
      id: f.id(),
      userId: f.id(),
      rank: f.num().nullable().optional(),
      note: f.str().nullable().optional()
    },
    scopes: {
      byUser: scope<NullableRow>({ by: { userId: 'userId' }, sort: { field: 'rank', dir: 'asc' } })
    }
  });

describe('transport realism blind-spot coverage', () => {
  it('B2 stores mixed numeric and string ids in one normalized scope bucket', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({
        data: {
          moments: [
            { id: 1, userId: 54, status: 'numeric' },
            { id: '2', userId: '54', status: 'string' }
          ]
        } as TData
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createMixedMoments();
    const query = moments.query<MixedResponse, ScopeValue, ScopeValue, MixedRow>('mixed-ids', {
      document,
      vars: value => value,
      select: data => data.moments,
      into: moments.scopes.byUser
    });
    const scopeReader = renderCounted(() => moments.scopes.byUser.use({ userId: '54' }));
    const queryReader = renderCountedInProvider(() => query.use({ userId: '54' }));

    await settle();

    expect(scopeReader.result().map(row => row.id)).toEqual(['1', '2']);
    scopeReader.unmount();
    queryReader.unmount();
  });

  it('B3 keeps the newer same-key response when an older response resolves last', async () => {
    const pending: Deferred<RaceResponse>[] = [];
    const transport = createMockTransport({
      query: async <TData,>() =>
        await new Promise<{ data: TData }>((resolve, reject) => {
          pending.push({
            resolve: data => resolve({ data: data as TData }),
            reject
          });
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createRaceMoments();
    const query = moments.query<RaceResponse, ScopeValue, ScopeValue, RaceRow>('same-key-race', {
      document,
      vars: value => value,
      select: data => data.moments,
      into: moments.scopes.byUser
    });
    const scopeReader = renderCounted(() => moments.scopes.byUser.use({ userId: '54' }));
    const queryReader = renderCountedInProvider(() => query.use({ userId: '54' }, { enabled: false }));

    await settle();
    pending.shift()?.resolve({ moments: [] });
    await settle();

    const firstFetch = query.fetch({ userId: '54' });
    const secondFetch = query.fetch({ userId: '54' });
    await settle();
    expect(pending).toHaveLength(2);

    pending[1]?.resolve({ moments: [{ id: 'b', userId: '54', status: 'newer' }] });
    await settle();
    pending[0]?.resolve({ moments: [{ id: 'a', userId: '54', status: 'older' }] });
    await settle();
    await Promise.all([firstFetch, secondFetch]);

    expect(scopeReader.result().map(row => ({ id: row.id, status: row.status }))).toEqual([{ id: 'b', status: 'newer' }]);
    scopeReader.unmount();
    queryReader.unmount();
  });

  it('drops a stale next page after a newer reset applies', async () => {
    const pending: Deferred<PageResponse>[] = [];
    const transport = createMockTransport({
      query: async <TData,>() =>
        await new Promise<{ data: TData }>((resolve, reject) => {
          pending.push({ resolve: data => resolve({ data: data as TData }), reject });
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createRaceMoments();
    const query = moments.query<PageResponse, ScopeValue, ScopeValue, RaceRow>('page-reset-race', {
      document,
      vars: value => value,
      page: data => data.moments,
      into: moments.scopes.byUser,
      coverage: 'page'
    });
    const scopeReader = renderCounted(() => moments.scopes.byUser.use({ userId: '54' }));
    const queryReader = renderCountedInProvider(() => query.use({ userId: '54' }));

    await settle();
    pending.shift()?.resolve({
      moments: { nodes: [{ id: 'A', userId: '54', status: 'old' }, { id: 'B', userId: '54', status: 'old' }], pageInfo: { hasNextPage: true, endCursor: 'after-B' } }
    });
    await settle();

    act(() => {
      queryReader.result().fetchNextPage();
    });
    await settle();
    const stalePage = pending.shift();
    expect(stalePage).toBeDefined();

    act(() => {
      void queryReader.result().refetch();
    });
    await settle();
    const reset = pending.shift();
    expect(reset).toBeDefined();
    reset?.resolve({
      moments: { nodes: [{ id: 'C', userId: '54', status: 'fresh' }, { id: 'D', userId: '54', status: 'fresh' }], pageInfo: { hasNextPage: false, endCursor: null } }
    });
    await settle();

    stalePage?.resolve({
      moments: { nodes: [{ id: 'E', userId: '54', status: 'stale' }, { id: 'F', userId: '54', status: 'stale' }], pageInfo: { hasNextPage: false, endCursor: null } }
    });
    await settle();

    expect(scopeReader.result().map(row => row.id)).toEqual(['C', 'D', 'A', 'B']);
    scopeReader.unmount();
    queryReader.unmount();
  });

  it('drops a next page after a newer reset is issued before it applies', async () => {
    const pending: Deferred<PageResponse>[] = [];
    const transport = createMockTransport({
      query: async <TData,>() =>
        await new Promise<{ data: TData }>((resolve, reject) => {
          pending.push({ resolve: data => resolve({ data: data as TData }), reject });
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createRaceMoments();
    const query = moments.query<PageResponse, ScopeValue, ScopeValue, RaceRow>('page-issued-reset-race', {
      document,
      vars: value => value,
      page: data => data.moments,
      into: moments.scopes.byUser,
      coverage: 'page'
    });
    const scopeReader = renderCounted(() => moments.scopes.byUser.use({ userId: '54' }));
    const queryReader = renderCountedInProvider(() => query.use({ userId: '54' }));

    await settle();
    pending.shift()?.resolve({
      moments: { nodes: [{ id: 'A', userId: '54', status: 'old' }, { id: 'B', userId: '54', status: 'old' }], pageInfo: { hasNextPage: true, endCursor: 'after-B' } }
    });
    await settle();

    act(() => {
      queryReader.result().fetchNextPage();
    });
    await settle();
    const stalePage = pending.shift();
    act(() => {
      void queryReader.result().refetch();
    });
    await settle();
    const reset = pending.shift();

    stalePage?.resolve({
      moments: { nodes: [{ id: 'E', userId: '54', status: 'stale' }, { id: 'F', userId: '54', status: 'stale' }], pageInfo: { hasNextPage: false, endCursor: null } }
    });
    await settle();
    reset?.resolve({
      moments: { nodes: [{ id: 'C', userId: '54', status: 'fresh' }, { id: 'D', userId: '54', status: 'fresh' }], pageInfo: { hasNextPage: false, endCursor: null } }
    });
    await settle();

    expect(scopeReader.result().map(row => row.id)).toEqual(['C', 'D', 'A', 'B']);
    scopeReader.unmount();
    queryReader.unmount();
  });

  it('appends a next page when no newer reset intervenes', async () => {
    const responses: PageResponse[] = [
      { moments: { nodes: [{ id: 'A', userId: '54', status: 'first' }, { id: 'B', userId: '54', status: 'first' }], pageInfo: { hasNextPage: true, endCursor: 'after-B' } } },
      { moments: { nodes: [{ id: 'E', userId: '54', status: 'next' }, { id: 'F', userId: '54', status: 'next' }], pageInfo: { hasNextPage: false, endCursor: null } } }
    ];
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({ query: async <TData,>() => ({ data: responses.shift() as TData }) }) });
    const moments = createRaceMoments();
    const query = moments.query<PageResponse, ScopeValue, ScopeValue, RaceRow>('page-no-reset', {
      document,
      vars: value => value,
      page: data => data.moments,
      into: moments.scopes.byUser,
      coverage: 'page'
    });
    const scopeReader = renderCounted(() => moments.scopes.byUser.use({ userId: '54' }));
    const queryReader = renderCountedInProvider(() => query.use({ userId: '54' }));

    await settle();
    act(() => {
      queryReader.result().fetchNextPage();
    });
    await settle();

    expect(scopeReader.result().map(row => row.id).sort()).toEqual(['A', 'B', 'E', 'F']);
    scopeReader.unmount();
    queryReader.unmount();
  });

  it('B5 preserves null and absent fields while sorting nullish transport values last', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({
        data: {
          moments: [
            { id: 'value', userId: 54, rank: 3, note: null },
            { id: 'null', userId: '54', rank: null },
            { id: 'missing', userId: 54 }
          ]
        } as TData
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createNullableMoments();
    const query = moments.query<NullableResponse, ScopeValue, ScopeValue, NullableRow>('nullable-fields', {
      document,
      vars: value => value,
      select: data => data.moments,
      into: moments.scopes.byUser
    });
    const scopeReader = renderCounted(() => moments.scopes.byUser.use({ userId: '54' }));
    const queryReader = renderCountedInProvider(() => query.use({ userId: '54' }));

    await settle();

    const rows = scopeReader.result();
    expect(rows.find(row => row.id === 'value')?.note).toBeNull();
    expect(Object.hasOwn(rows.find(row => row.id === 'null') ?? {}, 'note')).toBe(false);
    expect(rows.find(row => row.id === 'null')?.rank).toBeNull();
    expect(Object.hasOwn(rows.find(row => row.id === 'missing') ?? {}, 'rank')).toBe(false);
    expect(rows.map(row => row.id)).toEqual(['value', 'missing', 'null']);
    expect(rows.map(row => row.id)).toEqual(moments.scopes.byUser.read({ userId: '54' }).map(row => row.id));

    scopeReader.unmount();
    queryReader.unmount();
  });
});
