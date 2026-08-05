import { act } from 'react';
import { configureDb, defineModelRuntime, f, resetRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted, settle, renderCountedInProvider } from '../helpers/harness';

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

const createMixedMoments = () =>
  defineModelRuntime({
    id: 'SpecTransportMixedMoment',
    name: 'SpecTransportMixedMoment',
    fields: {
      id: f.id(),
      userId: f.id(),
      status: f.str()
    },
    scopes: {
      byUser: ({ by: { userId: 'userId' } })
    }
  });

const createRaceMoments = () =>
  defineModelRuntime({
    id: 'SpecTransportRaceMoment',
    name: 'SpecTransportRaceMoment',
    fields: {
      id: f.id(),
      userId: f.id(),
      status: f.str()
    },
    scopes: {
      byUser: ({ by: { userId: 'userId' } })
    }
  });

const createNullableMoments = () =>
  defineModelRuntime({
    id: 'SpecTransportNullableMoment',
    name: 'SpecTransportNullableMoment',
    fields: {
      id: f.id(),
      userId: f.id(),
      rank: f.num().nullable().optional(),
      note: f.str().nullable().optional()
    },
    scopes: {
      byUser: ({ by: { userId: 'userId' }, sort: { field: 'rank', dir: 'asc' } })
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

    const firstFetch = query.refresh({ userId: '54' });
    const secondFetch = query.refresh({ userId: '54' });
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

  it('lands a cross-handle reset that resolves after another declaration reset the same scope bucket', async () => {
    const pending: Deferred<RaceResponse>[] = [];
    const transport = createMockTransport({
      query: async <TData,>() =>
        await new Promise<{ data: TData }>((resolve, reject) => {
          pending.push({ resolve: data => resolve({ data: data as TData }), reject });
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createRaceMoments();
    const first = moments.query<RaceResponse, ScopeValue, ScopeValue, RaceRow>('cross-handle-first', {
      document,
      vars: value => value,
      select: data => data.moments,
      into: moments.scopes.byUser
    });
    const second = moments.query<RaceResponse, ScopeValue, ScopeValue, RaceRow>('cross-handle-second', {
      document: { kind: 'Document', definitions: [] } as never,
      vars: value => value,
      select: data => data.moments,
      into: moments.scopes.byUser
    });
    const scopeValue = { userId: '54' };

    const firstFetch = first.fetch(scopeValue);
    await settle();
    const secondFetch = second.fetch(scopeValue);
    await settle();
    pending[1]?.resolve({ moments: [{ id: 'b1', userId: '54', status: 'newer' }] });
    await secondFetch;
    pending[0]?.resolve({ moments: [{ id: 'a1', userId: '54', status: 'older' }] });
    await firstFetch;

    // Declarations do not share the supersession gate: the other declaration's reset cannot
    // swallow this landing, so the last landing owns the scope membership.
    expect(moments.scopes.byUser.read(scopeValue).map(row => row.id)).toEqual(['a1']);
    resetRuntime();
  });

  it('D16 applies a reset normally after resetRuntime clears shared scope guards', async () => {
    const pending: Deferred<RaceResponse>[] = [];
    const transport = createMockTransport({
      query: async <TData,>() =>
        await new Promise<{ data: TData }>((resolve, reject) => {
          pending.push({ resolve: data => resolve({ data: data as TData }), reject });
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createRaceMoments();
    const query = moments.query<RaceResponse, ScopeValue, ScopeValue, RaceRow>('cross-handle-reset-lifecycle', {
      document,
      vars: value => value,
      select: data => data.moments,
      into: moments.scopes.byUser
    });
    const scopeValue = { userId: '54' };
    const first = query.fetch(scopeValue);
    await settle();
    pending.shift()?.resolve({ moments: [{ id: 'before-reset', userId: '54', status: 'old' }] });
    await first;

    resetRuntime();
    configureDb({ storage: createMemoryPlane(), transport });
    const afterReset = query.fetch(scopeValue);
    await settle();
    pending.shift()?.resolve({ moments: [{ id: 'after-reset', userId: '54', status: 'fresh' }] });
    await afterReset;

    expect(moments.scopes.byUser.read(scopeValue).map(row => row.id)).toEqual(['after-reset']);
    resetRuntime();
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
      void queryReader.result().refresh();
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
      void queryReader.result().refresh();
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

  it('keeps a paged declaration landing its next page after another declaration reset the shared scope bucket', async () => {
    const pending: Deferred<PageResponse | RaceResponse>[] = [];
    const transport = createMockTransport({
      query: async <TData,>() =>
        await new Promise<{ data: TData }>((resolve, reject) => {
          pending.push({ resolve: data => resolve({ data: data as TData }), reject });
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createRaceMoments();
    const paged = moments.query<PageResponse, ScopeValue, ScopeValue, RaceRow>('cross-handle-page', {
      document,
      vars: value => value,
      page: data => data.moments,
      into: moments.scopes.byUser,
      coverage: 'page'
    });
    const reset = moments.query<RaceResponse, ScopeValue, ScopeValue, RaceRow>('cross-handle-reset', {
      document: { kind: 'Document', definitions: [] } as never,
      vars: value => value,
      select: data => data.moments,
      into: moments.scopes.byUser
    });
    const scopeValue = { userId: '54' };
    const reader = renderCountedInProvider(() => paged.use(scopeValue));

    await settle();
    pending.shift()?.resolve({ moments: { nodes: [{ id: 'a1', userId: '54', status: 'first' }], pageInfo: { hasNextPage: true, endCursor: 'cursor-a1' } } });
    await settle();
    act(() => {
      reader.result().fetchNextPage();
    });
    await settle();
    const stalePage = pending.shift();
    const resetFetch = reset.fetch(scopeValue);
    await settle();
    pending.shift()?.resolve({ moments: [{ id: 'b1', userId: '54', status: 'newer' }] });
    await resetFetch;
    stalePage?.resolve({ moments: { nodes: [{ id: 'a2', userId: '54', status: 'stale' }], pageInfo: { hasNextPage: false, endCursor: null } } });
    await settle();

    // The paged declaration's own gate saw no newer reset of ITS chain, so its page still lands;
    // only a reset within the same declaration supersedes it.
    expect(moments.scopes.byUser.read(scopeValue).map(row => row.id)).toEqual(['b1', 'a2']);
    reader.unmount();
    resetRuntime();
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
