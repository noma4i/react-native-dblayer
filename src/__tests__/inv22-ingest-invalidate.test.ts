import type { QueryClient } from '@tanstack/react-query';
import { buildScopeKey } from '../core/compileDbWhere';
import { configureDb } from '../dsl/configure';
import { defineIngest } from '../dsl/defineIngest';
import { defineModel } from '../dsl/defineModel';
import { defineQuery } from '../dsl/defineQuery';
import { scope } from '../dsl/scope';
import { f } from '../schema/f';
import type { DbGraphQLDocument } from '../types';

describe('inv22: ingest invalidate', () => {
  it('ingest invalidate:true refetch-invalidates model-destination queries', () => {
    const backing = new Map<string, string>();
    const invalidateQueries = jest.fn(async () => undefined);
    configureDb({
      transport: { query: async <TData>() => ({ data: {} as TData }), mutation: async <TData>() => ({ data: {} as TData }) },
      storage: {
        get: key => backing.get(key),
        set: entries => {
          for (const entry of entries) {
            if (entry.value === null) backing.delete(entry.key);
            else backing.set(entry.key, entry.value);
          }
        },
        keys: prefix => [...backing.keys()].filter(key => key.startsWith(prefix))
      },
      queryClient: { invalidateQueries } as unknown as QueryClient
    });
    const Model = defineModel({ id: 'InvProbe', name: 'InvProbe', fields: { title: f.str() } });
    defineQuery({
      document: { kind: 'Document', definitions: [] } as unknown as DbGraphQLDocument<unknown, Record<string, unknown>>,
      key: 'invProbeQuery',
      select: data => data,
      into: Model
    });
    const ingest = defineIngest(Model, { evt: payload => ({ upsert: payload, invalidate: true }) });
    ingest.apply('evt', { id: 'x', title: 't' });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['dbl', 'invProbeQuery'] });
  });

  it('scope handle invalidate reaches the query with a scoped key', () => {
    const backing = new Map<string, string>();
    const invalidateQueries = jest.fn(async () => undefined);
    configureDb({
      transport: { query: async <TData>() => ({ data: {} as TData }), mutation: async <TData>() => ({ data: {} as TData }) },
      storage: {
        get: key => backing.get(key),
        set: entries => {
          for (const entry of entries) {
            if (entry.value === null) backing.delete(entry.key);
            else backing.set(entry.key, entry.value);
          }
        },
        keys: prefix => [...backing.keys()].filter(key => key.startsWith(prefix))
      },
      queryClient: { invalidateQueries } as unknown as QueryClient
    });
    const Model = defineModel({ id: 'InvScopeProbe', name: 'InvScopeProbe', fields: { title: f.str() }, scopes: { all: scope({}) } });
    defineQuery({
      document: { kind: 'Document', definitions: [] } as unknown as DbGraphQLDocument<unknown, Record<string, unknown>>,
      key: 'invScopeQuery',
      select: data => data,
      into: Model.scopes.all
    });
    Model.scopes.all.invalidate({ chatId: '1' });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['dbl', 'invScopeQuery', buildScopeKey({ chatId: '1' })] });
  });
});
