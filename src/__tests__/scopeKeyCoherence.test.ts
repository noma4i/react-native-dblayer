import { buildScopeKey, ROOT_SCOPE_KEY } from '../core/compileDbWhere';
import { getCollectionFetchState } from '../core/freshnessStorage';
import { configureDb, devClearAllDataAndState } from '../index';
import { createTodoModel, installMemoryStorage, mockTransport } from './helpers/testRuntime';

describe('buildScopeKey canon', () => {
  afterEach(async () => {
    jest.restoreAllMocks();
    devClearAllDataAndState();
    configureDb({ transport: mockTransport({}), modelDefaults: {} });
  });

  it('collapses an empty object and undefined to the root scope key', () => {
    expect(buildScopeKey({})).toBe(ROOT_SCOPE_KEY);
    expect(buildScopeKey(undefined)).toBe(ROOT_SCOPE_KEY);
  });

  it('collapses an all-undefined-valued object to the root scope key', () => {
    expect(buildScopeKey({ a: undefined })).toBe(ROOT_SCOPE_KEY);
  });

  it('strips undefined-valued entries, matching the equivalent defined-only filter', () => {
    expect(buildScopeKey({ b: 1, a: undefined })).toBe(buildScopeKey({ b: 1 }));
  });

  it('is independent of key declaration order', () => {
    expect(buildScopeKey({ a: 1, b: 2 })).toBe(buildScopeKey({ b: 2, a: 1 }));
  });

  it('collapses array and other non-plain-object input to the root scope key', () => {
    expect(buildScopeKey([])).toBe(ROOT_SCOPE_KEY);
    expect(buildScopeKey([1, 2, 3])).toBe(ROOT_SCOPE_KEY);
    expect(buildScopeKey(null)).toBe(ROOT_SCOPE_KEY);
    expect(buildScopeKey('x')).toBe(ROOT_SCOPE_KEY);
    expect(buildScopeKey(42)).toBe(ROOT_SCOPE_KEY);
  });

  it('end-to-end: fetch-state written for an empty-object filter is visible to a read keyed by undefined (reachable {}/undefined regression case)', () => {
    const storage = installMemoryStorage();
    const model = createTodoModel({ id: 'scope-key-coherence' });

    model.markFetched({}, { empty: false });

    expect(model.getFetchState(undefined)).toMatchObject({ empty: false });
    expect(getCollectionFetchState('scope-key-coherence', undefined)).toMatchObject({ empty: false });
    expect(Object.keys(storage.dump()).filter(key => key.startsWith('tanstack-db-freshness:scope-key-coherence:'))).toEqual([
      'tanstack-db-freshness:scope-key-coherence:__root__'
    ]);
  });
});
