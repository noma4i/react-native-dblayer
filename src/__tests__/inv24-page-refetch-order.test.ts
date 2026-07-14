import { createScopeIndex } from '../core/planes/scopeIndex';
import type { StoragePlane } from '../core/planes/storagePlane';
import { configureDb } from '../dsl/configure';
import { defineModel } from '../dsl/defineModel';
import { defineQuery } from '../dsl/defineQuery';
import { scope } from '../dsl/scope';
import { f } from '../schema/f';
import type { DbGraphQLDocument } from '../types';

const createStorage = (): StoragePlane => {
  const values = new Map<string, string>();
  return {
    get: key => values.get(key),
    set: entries => {
      for (const entry of entries) {
        if (entry.value === null) values.delete(entry.key);
        else values.set(entry.key, entry.value);
      }
    },
    keys: prefix => [...values.keys()].filter(key => key.startsWith(prefix))
  };
};

describe('inv24: page refetch order', () => {
  it('places a reset page ahead of prior page membership', () => {
    const scopeIndex = createScopeIndex({ modelId: 'OrderProbe', storage: createStorage(), prefix: () => 'dbl:test:' });
    scopeIndex.reconcile('k', 'page', [{ id: 'a' }, { id: 'b' }]);
    scopeIndex.reconcile('k', 'page', [{ id: 'c' }]);
    scopeIndex.reconcile('k', 'page', [{ id: 'n' }, { id: 'a' }, { id: 'b' }], { resetOrder: true });

    expect(scopeIndex.read('k').entries.map(entry => entry.id)).toEqual(['n', 'a', 'b', 'c']);
  });

  it('places first-page refetch rows ahead of previously loaded rows', async () => {
    const responses = [
      { conn: { nodes: [{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }], pageInfo: { hasNextPage: true, endCursor: 'c1' } } },
      { conn: { nodes: [{ id: 'n', title: 'n' }, { id: 'a', title: 'a' }, { id: 'b', title: 'b' }], pageInfo: { hasNextPage: true, endCursor: 'c1' } } }
    ];
    configureDb({
      storage: createStorage(),
      transport: {
        query: async <TData>() => ({ data: responses.shift() as TData }),
        mutation: async <TData>() => ({ data: {} as TData })
      }
    });
    const Model = defineModel({
      id: 'OrderProbe',
      name: 'OrderProbe',
      fields: { title: f.str() },
      scopes: { feed: scope({ sort: 'server-order' }) }
    });
    const query = defineQuery({
      document: { kind: 'Document', definitions: [] } as unknown as DbGraphQLDocument<unknown, Record<string, unknown>>,
      key: 'orderProbeQuery',
      page: data => (data as { conn: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string } } }).conn,
      into: Model.scopes.feed
    });

    await query.fetch({});
    Model.scopes.feed.__apply?.({}, [{ id: 'c', title: 'c' }], 'page');
    await query.fetch({});

    expect(Model.scopes.feed.read({}).map(row => row.id)).toEqual(['n', 'a', 'b', 'c']);
  });
});
