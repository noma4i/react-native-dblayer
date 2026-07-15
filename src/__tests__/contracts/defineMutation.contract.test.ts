import { hasMany } from '../../core/relations';
import { defineModel } from '../../dsl/defineModel';
import { defineMutation } from '../../dsl/defineMutation';
import { f } from '../../schema/f';
import type { DbGraphQLDocument, DbTransport } from '../../types';
import { createContractScenario } from '../helpers/contractScenario';

const document = { kind: 'Document', definitions: [] } as unknown as DbGraphQLDocument<unknown, Record<string, unknown>>;

/*
 * C1: Optimistic lifecycle rejects cascading destroys before state or transport changes.
 * C2: Failed optimistic patches restore both replaced and newly-added fields.
 * C3: Failed leaf destroys restore the removed row.
 * C4: Dedupe skips a committed idempotency key and failed optimistic inserts roll back their temp row.
 */
describe('defineMutation contracts', () => {
  it('C1: optimistic destroy with dependent cascades rejects before any write or transport call', async () => {
    const mutation = jest.fn(async <TData>() => ({ data: {} as TData })) as unknown as jest.MockedFunction<DbTransport['mutation']>;
    createContractScenario({ transport: { mutation } });
    const Child = defineModel({ id: 'CascadeChildContract', name: 'CascadeChildContract', fields: { parentId: f.id() } });
    const Parent = defineModel({ id: 'CascadeParentContract', name: 'CascadeParentContract', fields: {}, relations: () => ({ children: hasMany(Child, { foreignKey: 'parentId', dependent: 'destroy' }) }) });
    Parent.insertStored({ id: 'parent' });
    Child.insertStored({ id: 'child', parentId: 'parent' });
    const destroy = defineMutation<unknown, { id: string }, { id: string }, unknown>({ document, result: 'destroy', optimistic: { method: 'destroy', model: Parent, selectId: input => input.id } });

    await expect(destroy.run({ id: 'parent' })).rejects.toThrow('dependent cascades');
    expect(mutation).not.toHaveBeenCalled();
    expect(Parent.get('parent')).toBeDefined();
    expect(Child.get('child')).toBeDefined();
  });

  it('C2: failed optimistic patches remove keys that did not exist before the mutation', async () => {
    const mutation = jest.fn(async <TData>() => ({ data: {} as TData })) as unknown as jest.MockedFunction<DbTransport['mutation']>;
    mutation.mockRejectedValueOnce(new Error('boom'));
    createContractScenario({ transport: { mutation } });
    const Model = defineModel({ id: 'PatchContract', name: 'PatchContract', fields: { title: f.str() } });
    Model.insertStored({ id: 'row', title: 'kept' });
    const patch = defineMutation<unknown, Record<string, never>, { id: string; title: string; extra?: string }, unknown>({ document, result: 'patch', optimistic: { method: 'patch', model: Model, selectId: () => 'row', selectPatch: () => ({ title: 'changed', extra: 'added' }) } });

    await expect(patch.run({})).rejects.toThrow('boom');
    expect(Model.get('row')).toEqual({ id: 'row', title: 'kept' });
  });

  it('C3: failed optimistic leaf destroy restores the removed row', async () => {
    const mutation = jest.fn(async <TData>() => ({ data: {} as TData })) as unknown as jest.MockedFunction<DbTransport['mutation']>;
    mutation.mockRejectedValueOnce(new Error('boom'));
    createContractScenario({ transport: { mutation } });
    const Model = defineModel({ id: 'LeafDestroyContract', name: 'LeafDestroyContract', fields: { title: f.str() } });
    Model.insertStored({ id: 'row', title: 'kept' });
    const destroy = defineMutation<unknown, Record<string, never>, { id: string; title: string }, unknown>({ document, result: 'destroy', optimistic: { method: 'destroy', model: Model, selectId: () => 'row' } });

    await expect(destroy.run({})).rejects.toThrow('boom');
    expect(Model.get('row')).toEqual({ id: 'row', title: 'kept' });
  });

  it('C4: a committed dedupe key skips the second transport call', async () => {
    const mutation = jest.fn(async <TData>() => ({ data: { save: { id: 'server' } } as TData })) as unknown as jest.MockedFunction<DbTransport['mutation']>;
    createContractScenario({ transport: { mutation } });
    const run = defineMutation<{ save: { id: string } }, { key: string }, { id: string }, { id: string }>({ document, result: 'save', dedupe: { key: input => input.key } });

    await expect(run.run({ key: 'same' })).resolves.toEqual({ save: { id: 'server' } });
    await expect(run.run({ key: 'same' })).resolves.toBeNull();
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it('C4: a failed optimistic insert removes its temporary row', async () => {
    const mutation = jest.fn(async <TData>() => ({ data: {} as TData })) as unknown as jest.MockedFunction<DbTransport['mutation']>;
    mutation.mockRejectedValueOnce(new Error('boom'));
    createContractScenario({ transport: { mutation } });
    const Model = defineModel({ id: 'InsertRollbackContract', name: 'InsertRollbackContract', fields: { title: f.str() } });
    const insert = defineMutation<unknown, { title: string }, { id: string; title: string }, unknown>({
      document,
      result: 'insert',
      optimistic: { model: Model, build: (input, context) => ({ id: context.tempId!, title: input.title }), selectServerNode: () => null }
    });

    await expect(insert.run({ title: 'temporary' })).rejects.toThrow('boom');
    expect(Model.getAll()).toEqual([]);
  });
});
