import { hasMany } from '../../core/relations';
import { defineModel } from '../../dsl/defineModel';
import { scope } from '../../dsl/scope';
import { defineMutation } from '../../dsl/defineMutation';
import { getApplyRuntime, getOperationState } from '../../dsl/configure';
import { resetRuntimeSync } from '../../core/reset';
import { f } from '../../schema/f';
import type { DbGraphQLDocument, DbTransport } from '../../types';
import { createContractScenario } from '../helpers/contractScenario';

const document = { kind: 'Document', definitions: [] } as unknown as DbGraphQLDocument<unknown, Record<string, unknown>>;

/*
 * C1: Optimistic lifecycle rejects cascading destroys before state or transport changes.
 * C2: Failed optimistic patches restore both replaced and newly-added fields.
 * C3: Failed leaf destroys restore the removed row.
 * C4: Dedupe skips a committed idempotency key and failed optimistic inserts roll back their temp row.
 * C5-C6: Transport results from a pre-reset runtime cannot commit or roll back the new runtime.
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

  it('C5: a resolved pre-reset transport result cannot write into the new runtime', async () => {
    let resolveTransport!: (value: { data: { save: { id: string; title: string } } }) => void;
    const transport = jest.fn(() => new Promise<{ data: { save: { id: string; title: string } } }>(resolve => { resolveTransport = resolve; })) as unknown as jest.MockedFunction<DbTransport['mutation']>;
    const onCommit = jest.fn();
    const onError = jest.fn();
    const scenario = createContractScenario({ transport: { mutation: transport } });
    const Model = defineModel({ id: 'MutationResetResolveContract', name: 'MutationResetResolveContract', fields: { title: f.str() }, scopes: { feed: scope({}) } });
    const mutation = defineMutation<{ save: { id: string; title: string } }, { title: string }, { id: string; title: string }, { id: string; title: string }>({
      document,
      result: 'save',
      optimistic: { model: Model, build: (input, context) => ({ id: context.tempId!, title: input.title }), selectServerNode: data => data.save },
      onCommit,
      onError
    });
    const pending = mutation.run({ title: 'old-world' });

    resetRuntimeSync();
    resolveTransport({ data: { save: { id: 'server', title: 'new-world' } } });

    await expect(pending).resolves.toBeNull();
    expect(Model.getAll()).toEqual([]);
    expect(Model.scopes.feed.read({})).toEqual([]);
    expect(scenario.storage.keys('dbl:scope:MutationResetResolveContract:')).toEqual([]);
    expect(scenario.storage.keys('dbl:journal:')).toEqual([]);
    expect(getApplyRuntime().currentEpoch()).toBe(0);
    expect(getOperationState().pending()).toEqual([]);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('C6: a rejected pre-reset transport result cannot roll back into the new runtime', async () => {
    let rejectTransport!: (error: Error) => void;
    const transport = jest.fn(() => new Promise<never>((_, reject) => { rejectTransport = reject; })) as unknown as jest.MockedFunction<DbTransport['mutation']>;
    const onCommit = jest.fn();
    const onError = jest.fn();
    const scenario = createContractScenario({ transport: { mutation: transport } });
    const Model = defineModel({ id: 'MutationResetRejectContract', name: 'MutationResetRejectContract', fields: { title: f.str() }, scopes: { feed: scope({}) } });
    const mutation = defineMutation<unknown, { title: string }, { id: string; title: string }, unknown>({
      document,
      result: 'save',
      optimistic: { model: Model, build: (input, context) => ({ id: context.tempId!, title: input.title }), selectServerNode: () => null },
      onCommit,
      onError
    });
    const pending = mutation.run({ title: 'old-world' });

    resetRuntimeSync();
    rejectTransport(new Error('old-world failure'));

    await expect(pending).resolves.toBeNull();
    expect(Model.getAll()).toEqual([]);
    expect(Model.scopes.feed.read({})).toEqual([]);
    expect(scenario.storage.keys('dbl:scope:MutationResetRejectContract:')).toEqual([]);
    expect(scenario.storage.keys('dbl:journal:')).toEqual([]);
    expect(getApplyRuntime().currentEpoch()).toBe(0);
    expect(getOperationState().pending()).toEqual([]);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
