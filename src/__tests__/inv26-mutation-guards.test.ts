import { hasMany } from '../core/relations';
import type { StoragePlane } from '../core/planes/storagePlane';
import { configureDb } from '../dsl/configure';
import { defineModel } from '../dsl/defineModel';
import { defineMutation } from '../dsl/defineMutation';
import { f } from '../schema/f';
import type { DbGraphQLDocument, DbTransport } from '../types';

const dummyDocument = { kind: 'Document', definitions: [] } as unknown as DbGraphQLDocument<unknown, Record<string, unknown>>;

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

const setup = () => {
  const mutationSpy = jest.fn(async <TData>() => ({ data: {} as TData })) as unknown as jest.MockedFunction<DbTransport['mutation']>;
  configureDb({
    storage: createStorage(),
    transport: {
      query: async <TData>() => ({ data: {} as TData }),
      mutation: mutationSpy
    }
  });
  return mutationSpy;
};

describe('inv26: mutation guards', () => {
  it('optimistic destroy on a cascading model is rejected before any state change', async () => {
    const mutationSpy = setup();
    const Child = defineModel({ id: 'CascChild', name: 'CascChild', fields: { parentId: f.id() } });
    const Parent = defineModel({
      id: 'CascParent',
      name: 'CascParent',
      fields: {},
      relations: () => ({ children: hasMany(Child, { foreignKey: 'parentId', dependent: 'destroy' }) })
    });
    Parent.insertStored({ id: 'p1' });
    Child.insertStored({ id: 'c1', parentId: 'p1' });
    const destroyParent = defineMutation<unknown, { id: string }, { id: string }, unknown>({
      document: dummyDocument,
      result: 'destroyParent',
      optimistic: { method: 'destroy' as const, model: Parent, selectId: (input: { id: string }) => input.id }
    });

    await expect(destroyParent.run({ id: 'p1' })).rejects.toThrow('dependent cascades');
    expect(mutationSpy).not.toHaveBeenCalled();
    expect(Parent.get('p1')).toBeDefined();
    expect(Child.get('c1')).toBeDefined();
  });

  it('failed patch rollback removes keys the patch added', async () => {
    const mutationSpy = setup();
    const Model = defineModel({ id: 'PatchGuard', name: 'PatchGuard', fields: { title: f.str() } });
    Model.insertStored({ id: 'row1', title: 'kept' });
    mutationSpy.mockRejectedValueOnce(new Error('boom'));
    const patchIt = defineMutation<unknown, Record<string, never>, { id: string; title: string; extra?: string }, unknown>({
      document: dummyDocument,
      result: 'patchIt',
      optimistic: { method: 'patch' as const, model: Model, selectId: () => 'row1', selectPatch: () => ({ title: 'changed', extra: 'added' }) }
    });

    await expect(patchIt.run({})).rejects.toThrow('boom');
    const row = Model.get('row1') as { title: string; extra?: string };
    expect(row.title).toBe('kept');
    expect(row.extra).toBeUndefined();
  });

  it('leaf model optimistic destroy still works', async () => {
    const mutationSpy = setup();
    const Model = defineModel({ id: 'LeafGuard', name: 'LeafGuard', fields: { title: f.str() } });
    Model.insertStored({ id: 'row1', title: 'kept' });
    mutationSpy.mockRejectedValueOnce(new Error('boom'));
    const destroyLeaf = defineMutation<unknown, Record<string, never>, { id: string; title: string }, unknown>({
      document: dummyDocument,
      result: 'destroyLeaf',
      optimistic: { method: 'destroy' as const, model: Model, selectId: () => 'row1' }
    });

    await expect(destroyLeaf.run({})).rejects.toThrow('boom');
    expect(Model.get('row1')).toBeDefined();
  });
});
