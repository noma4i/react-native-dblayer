import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import {
  configureDb,
  defineModel,
  defineShape,
  f,
  resetRuntime,
  type DbTransport
} from '../../testApi';
import { createMemoryPlane, createMockTransport, settle } from '../helpers/harness';

type Row = { id: string; value: string; extra?: string };
type Input = { id?: string; value: string };
type Data = { apply: { row: Row } };
type Variables = { input: Input };

const document: TypedDocumentNode<Data, Variables> = { kind: Kind.DOCUMENT, definitions: [] };
const RowSchema = defineShape<Row>()({ value: f.str(), extra: f.str().optional() });

afterEach(() => resetRuntime());

describe('action runtime edges', () => {
  it('rejects invalid request declarations and inputs before transport', async () => {
    const transport = createMockTransport();
    configureDb({ storage: createMemoryPlane(), transport });

    expect(() =>
      defineModel('SpecActionInvalidOnce', {
        schema: RowSchema,
        actions: owner => ({
          apply: owner.gql.action(document, {
            mode: 'request',
            result: 'apply',
            once: true,
            dedupe: false,
            variables: (input: Input) => ({ input }),
            root: { insert: { select: ({ data }) => data.apply.row } }
          })
        })
      })
    ).toThrow('once cannot be combined with dedupe: false');

    const Model = defineModel('SpecActionInvalidInput', {
      schema: RowSchema,
      actions: owner => ({
        apply: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          dedupe: { key: () => '' },
          variables: (input: Input) => ({ input }),
          root: { insert: { select: ({ data }) => data.apply.row } }
        })
      })
    });
    const cyclic: Input & { self?: unknown } = { value: 'cyclic' };
    cyclic.self = cyclic;

    await expect(Model.actions.apply.run(cyclic)).rejects.toThrow('action input is not JSON serializable');
    await expect(Model.actions.apply.run({ value: 'invalid-dedupe' })).rejects.toThrow('dedupe key must be a non-empty string');
    expect(transport.calls).toHaveLength(0);
  });

  it('does not send a request after before or variables resets runtime', async () => {
    const transport = createMockTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const Before = defineModel('SpecActionBeforeReset', {
      schema: RowSchema,
      actions: owner => ({
        apply: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          before: () => resetRuntime(),
          variables: (input: Input) => ({ input }),
          root: { insert: { select: ({ data }) => data.apply.row } }
        })
      })
    });
    const Variables = defineModel('SpecActionVariablesReset', {
      schema: RowSchema,
      actions: owner => ({
        apply: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          variables: (input: Input) => {
            resetRuntime();
            return { input };
          },
          root: { insert: { select: ({ data }) => data.apply.row } }
        })
      })
    });

    await expect(Before.actions.apply.run({ value: 'before' })).resolves.toBeNull();
    await expect(Variables.actions.apply.run({ value: 'variables' })).resolves.toBeNull();
    expect(transport.calls).toHaveLength(0);
  });

  it('contains request callback errors and keeps the committed response', async () => {
    const onSyncError = jest.fn();
    const transport = createMockTransport({
      mutation: async <TData,>() => ({ data: { apply: { row: { id: 'server-1', value: 'server' } } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport, defaults: { onSyncError } });
    const invalidation = { invalidate: () => { throw new Error('invalidate failed'); } };
    const Model = defineModel('SpecActionCallbackErrors', {
      schema: RowSchema,
      actions: owner => ({
        apply: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          variables: (input: Input) => ({ input }),
          root: { insert: { select: ({ data }) => data.apply.row } },
          write: (_context, plan) => plan.invalidate(invalidation),
          track: () => { throw new Error('track failed'); }
        })
      })
    });

    await expect(Model.actions.apply.run({ value: 'input' })).resolves.toEqual({ row: { id: 'server-1', value: 'server' } });
    expect(Model.find('server-1')).toEqual({ id: 'server-1', value: 'server' });
    expect(onSyncError).toHaveBeenCalledTimes(2);
    expect(onSyncError).toHaveBeenNthCalledWith(1, expect.any(Error), {
      source: 'action',
      model: Model.key,
      key: 'write.invalidate'
    });
    expect(onSyncError).toHaveBeenNthCalledWith(2, expect.any(Error), {
      source: 'action',
      model: Model.key,
      key: 'track'
    });
  });

  it('reports an error callback failure without replacing the transport error', async () => {
    const transportFailure = new Error('transport failed');
    const onSyncError = jest.fn();
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ mutation: async () => Promise.reject(transportFailure) }),
      defaults: { onSyncError }
    });
    const Model = defineModel('SpecActionErrorCallback', {
      schema: RowSchema,
      actions: owner => ({
        apply: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          variables: (input: Input) => ({ input }),
          root: { insert: { select: ({ data }) => data.apply.row } },
          error: () => { throw new Error('error callback failed'); }
        })
      })
    });

    await expect(Model.actions.apply.run({ value: 'input' })).rejects.toBe(transportFailure);
    expect(onSyncError).toHaveBeenCalledWith(expect.any(Error), {
      source: 'action',
      model: Model.key,
      key: 'error'
    });
  });

  it('rolls back added fields without overwriting a later committed action', async () => {
    const pending: Array<{ resolve(data: Data): void; reject(error: Error): void }> = [];
    const transport = createMockTransport({
      mutation: <TData,>() =>
        new Promise<{ data: TData }>((resolve, reject) => {
          pending.push({ resolve: data => resolve({ data: data as TData }), reject });
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const Model = defineModel('SpecActionRollbackFields', {
      schema: RowSchema,
      actions: owner => ({
        addField: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          variables: (input: Input) => ({ input }),
          optimistic: {
            root: { update: { select: ({ input }) => ({ id: input.id!, patch: { extra: 'optimistic' } }) } }
          },
          root: { update: { select: ({ data }) => ({ id: data.apply.row.id, patch: { value: data.apply.row.value, extra: data.apply.row.extra } }) } }
        }),
        updateValue: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          variables: (input: Input) => ({ input }),
          optimistic: {
            root: { update: { select: ({ input }) => ({ id: input.id!, patch: { value: input.value } }) } }
          },
          root: { update: { select: ({ data }) => ({ id: data.apply.row.id, patch: { value: data.apply.row.value } }) } }
        })
      })
    });
    Model.insert({ id: 'row-1', value: 'base' });

    const addField = Model.actions.addField.run({ id: 'row-1', value: 'unused' });
    await settle();
    pending.shift()!.reject(new Error('add field failed'));
    await expect(addField).rejects.toThrow('add field failed');
    expect(Model.find('row-1')).toEqual({ id: 'row-1', value: 'base' });

    const firstUpdate = Model.actions.updateValue.run({ id: 'row-1', value: 'first-optimistic' });
    await settle();
    const secondUpdate = Model.actions.updateValue.run({ id: 'row-1', value: 'second-optimistic' });
    await settle();
    pending[1]!.resolve({ apply: { row: { id: 'row-1', value: 'confirmed-second' } } });
    await expect(secondUpdate).resolves.toEqual({ row: { id: 'row-1', value: 'confirmed-second' } });
    pending[0]!.reject(new Error('first update failed'));
    await expect(firstUpdate).rejects.toThrow('first update failed');
    expect(Model.find('row-1')).toEqual({ id: 'row-1', value: 'confirmed-second' });
  });

  it('closes a failed patch when the target disappears during transport', async () => {
    let rejectMutation!: (error: Error) => void;
    const transport = createMockTransport({
      mutation: <TData,>(_operation: Parameters<DbTransport['mutation']>[0]) =>
        new Promise<{ data: TData }>((_resolve, reject) => {
          rejectMutation = reject;
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const Model = defineModel('SpecActionMissingRollbackTarget', {
      schema: RowSchema,
      actions: owner => ({
        apply: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          variables: (input: Input) => ({ input }),
          optimistic: {
            root: { update: { select: ({ input }) => ({ id: input.id!, patch: { value: 'optimistic' } }) } }
          },
          root: { update: { select: ({ data }) => ({ id: data.apply.row.id, patch: { value: data.apply.row.value } }) } }
        })
      })
    });
    Model.insert({ id: 'row-1', value: 'base' });
    const pending = Model.actions.apply.run({ id: 'row-1', value: 'unused' });
    await settle();
    Model.destroy('row-1');
    rejectMutation(new Error('missing target failure'));

    await expect(pending).rejects.toThrow('missing target failure');
    expect(Model.find('row-1')).toBeUndefined();
    expect(Model.operation('row-1').read().pending).toBe(false);
  });

  it('returns null for retry and discard without a matching failed operation', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const Model = defineModel('SpecActionMissingFailure', {
      schema: RowSchema,
      actions: owner => ({
        apply: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          variables: (input: Input) => ({ input }),
          optimistic: {
            root: { update: { select: ({ input }) => ({ id: input.id!, patch: { value: input.value } }) } }
          },
          root: { update: { select: ({ data }) => ({ id: data.apply.row.id, patch: { value: data.apply.row.value } }) } }
        })
      })
    });

    await expect(Model.actions.apply.retry('missing')).resolves.toBeNull();
    expect(() => Model.actions.apply.discard('missing')).not.toThrow();
  });
});
