import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import {
  createCommitEnvelope,
  configureDb,
  defineModel,
  defineShape,
  f,
  getApplyRuntime,
  getCommitBus,
  getOperationState,
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
          apply: owner.gql.action(
            document,
            {
              mode: 'request',
              result: 'apply',
              once: true,
              dedupe: false,
              variables: (input: Input) => ({ input }),
              root: { insert: { select: ({ data }: { data: Data }) => data.apply.row } }
            } as never
          )
        })
      })
    ).toThrow('once cannot be combined with dedupe: false');

    expect(() =>
      defineModel('SpecActionBareOnce', {
        schema: RowSchema,
        actions: owner => ({
          apply: owner.gql.action(
            document,
            {
              mode: 'request',
              result: 'apply',
              once: true,
              variables: (input: Input) => ({ input }),
              root: { insert: { select: ({ data }: { data: Data }) => data.apply.row } }
            } as never
          )
        })
      })
    ).toThrow('once requires a dedupe key');

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

  it('rejects malformed optimistic and response roots without partial writes', async () => {
    const successTransport = createMockTransport({
      mutation: async <TData,>() => ({ data: { apply: { row: { id: 'server', value: 'server' } } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport: successTransport });
    const defineRequest = (key: string, optimistic: unknown, root: unknown) =>
      defineModel(key, {
        schema: RowSchema,
        maintenance: { dropTempRowsAfterMs: 60_000 },
        actions: owner => ({
          apply: owner.gql.action(document, {
            mode: 'request',
            result: 'apply',
            variables: (input: Input) => ({ input }),
            optimistic: optimistic as never,
            root: root as never
          })
        })
      });
    const MultipleInsert = defineRequest(
      'SpecActionMultipleOptimisticInsert',
      { root: { insert: { select: ({ tempId }: { tempId: string }) => [{ id: tempId, value: 'first' }, { id: 'second', value: 'second' }] } } },
      { insert: { select: ({ data }: { data: Data }) => data.apply.row } }
    );
    const EmptyInsert = defineRequest(
      'SpecActionEmptyOptimisticInsert',
      { root: { insert: { select: () => null } } },
      { insert: { select: ({ data }: { data: Data }) => data.apply.row } }
    );
    const MissingUpdate = defineRequest(
      'SpecActionMissingOptimisticUpdate',
      { root: { update: { select: () => ({ id: 'missing', patch: { value: 'optimistic' } }) } } },
      { update: { select: ({ data }: { data: Data }) => ({ id: data.apply.row.id, patch: { value: data.apply.row.value } }) } }
    );
    const MultipleDestroy = defineRequest(
      'SpecActionMultipleOptimisticDestroy',
      { root: { destroy: { select: () => ['first', 'second'] } } },
      { destroy: { select: ({ data }: { data: Data }) => data.apply.row.id } }
    );
    const MissingDestroy = defineRequest(
      'SpecActionMissingOptimisticDestroy',
      { root: { destroy: { select: () => 'missing' } } },
      { destroy: { select: ({ data }: { data: Data }) => data.apply.row.id } }
    );

    await expect(MultipleInsert.actions.apply.run({ value: 'multiple' })).rejects.toThrow('optimistic insert selector must return exactly one row');
    await expect(EmptyInsert.actions.apply.run({ value: 'empty' })).rejects.toThrow('optimistic insert selector must return exactly one row');
    await expect(MissingUpdate.actions.apply.run({ value: 'update' })).rejects.toThrow('optimistic update target is missing');
    await expect(MultipleDestroy.actions.apply.run({ value: 'destroy' })).rejects.toThrow('optimistic destroy selector must return exactly one destroy');
    await expect(MissingDestroy.actions.apply.run({ value: 'destroy' })).rejects.toThrow('optimistic destroy target is missing');
    expect(successTransport.calls).toHaveLength(0);

    const missingPayloadTransport = createMockTransport({ mutation: async <TData,>() => ({ data: { apply: null } as TData }) });
    configureDb({ storage: createMemoryPlane(), transport: missingPayloadTransport });
    const MissingPayload = defineRequest(
      'SpecActionMissingResponsePayload',
      undefined,
      { insert: { select: ({ data }: { data: Data }) => data.apply.row } }
    );
    await expect(MissingPayload.actions.apply.run({ value: 'missing' })).rejects.toThrow('apply returned no data');

    configureDb({ storage: createMemoryPlane(), transport: successTransport });
    const EmptyResponse = defineRequest(
      'SpecActionEmptyResponseInsert',
      { root: { insert: { select: ({ tempId }: { tempId: string }) => ({ id: tempId, value: 'optimistic' }) } } },
      { insert: { select: () => null } }
    );
    const MultipleResponse = defineRequest(
      'SpecActionMultipleResponseInsert',
      { root: { insert: { select: ({ tempId }: { tempId: string }) => ({ id: tempId, value: 'optimistic' }) } } },
      { insert: { select: ({ data }: { data: Data }) => [data.apply.row, { ...data.apply.row, id: 'second' }] } }
    );
    await expect(EmptyResponse.actions.apply.run({ value: 'empty' })).rejects.toThrow('response insert selector must return exactly one row');
    await expect(MultipleResponse.actions.apply.run({ value: 'multiple' })).rejects.toThrow('response insert selector must return exactly one row');
  });

  it('fences every asynchronous request landing after a runtime reset', async () => {
    const response = { apply: { row: { id: 'server', value: 'server' } } };
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        mutation: async <TData,>() => {
          resetRuntime();
          return { data: response as TData };
        }
      })
    });
    const TransportReset = defineModel('SpecActionTransportReset', {
      schema: RowSchema,
      actions: owner => ({
        apply: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          variables: (input: Input) => ({ input }),
          root: { insert: { select: ({ data }) => data.apply.row } }
        })
      })
    });
    await expect(TransportReset.actions.apply.run({ value: 'transport' })).resolves.toBeNull();

    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({ mutation: async <TData,>() => ({ data: response as TData }) }) });
    const ResponseReset = defineModel('SpecActionResponseReset', {
      schema: RowSchema,
      actions: owner => ({
        apply: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          variables: (input: Input) => ({ input }),
          root: { insert: { select: ({ data }) => { resetRuntime(); return data.apply.row; } } }
        })
      })
    });
    await expect(ResponseReset.actions.apply.run({ value: 'response' })).resolves.toBeNull();

    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({ mutation: async <TData,>() => ({ data: response as TData }) }) });
    const ResetScalar = f.custom<string, string>(value => { resetRuntime(); return value; });
    const Sibling = defineModel('SpecActionWriteResetSibling', {
      schema: defineShape<{ id: string; value: string }>()({ value: ResetScalar })
    });
    const WriteReset = defineModel('SpecActionWriteReset', {
      schema: RowSchema,
      actions: owner => ({
        apply: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          variables: (input: Input) => ({ input }),
          root: { insert: { select: ({ data }) => data.apply.row } },
          write: (_context, plan) => plan.upsert(Sibling, { id: 'sibling', value: 'reset' })
        })
      })
    });
    await expect(WriteReset.actions.apply.run({ value: 'write' })).resolves.toBeNull();

    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({ mutation: async <TData,>() => ({ data: response as TData }) }) });
    const CommitReset = defineModel('SpecActionCommitReset', {
      schema: RowSchema,
      actions: owner => ({
        apply: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          variables: (input: Input) => ({ input }),
          root: { insert: { select: ({ data }) => data.apply.row } }
        })
      })
    });
    const unsubscribeCommit = getCommitBus().subscribeAll(() => resetRuntime());
    await expect(CommitReset.actions.apply.run({ value: 'commit' })).resolves.toBeNull();
    unsubscribeCommit();

    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({ mutation: async <TData,>() => ({ data: response as TData }) }) });
    const InvalidationReset = defineModel('SpecActionInvalidationReset', {
      schema: RowSchema,
      actions: owner => ({
        apply: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          variables: (input: Input) => ({ input }),
          root: { insert: { select: ({ data }) => data.apply.row } },
          write: (_context, plan) => plan.invalidate({ invalidate: () => resetRuntime() })
        })
      })
    });
    await expect(InvalidationReset.actions.apply.run({ value: 'invalidate' })).resolves.toBeNull();

    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({ mutation: async <TData,>() => ({ data: response as TData }) }) });
    const TrackReset = defineModel('SpecActionTrackReset', {
      schema: RowSchema,
      actions: owner => ({
        apply: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          variables: (input: Input) => ({ input }),
          root: { insert: { select: ({ data }) => data.apply.row } },
          track: () => resetRuntime()
        })
      })
    });
    await expect(TrackReset.actions.apply.run({ value: 'track' })).resolves.toBeNull();

    let rejectMutation!: (error: Error) => void;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        mutation: <TData,>() => new Promise<{ data: TData }>((_resolve, reject) => { rejectMutation = reject; })
      })
    });
    const FailureReset = defineModel('SpecActionFailureReset', {
      schema: RowSchema,
      actions: owner => ({
        apply: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          variables: (input: Input) => ({ input }),
          root: { insert: { select: ({ data }) => data.apply.row } }
        })
      })
    });
    const stale = FailureReset.actions.apply.run({ value: 'failure' });
    await settle();
    resetRuntime();
    rejectMutation(new Error('stale failure'));
    await expect(stale).resolves.toBeNull();
  });

  it('fails closed when a tracked request ledger entry changes in flight', async () => {
    const pendingResponses: Array<(data: Data) => void> = [];
    const transport = createMockTransport({
      mutation: <TData,>() => new Promise<{ data: TData }>(resolve => {
        pendingResponses.push(data => resolve({ data: data as TData }));
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const Model = defineModel('SpecActionLedgerFence', {
      schema: RowSchema,
      maintenance: { dropTempRowsAfterMs: 60_000 },
      actions: owner => ({
        tracked: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          dedupe: { key: input => input.value },
          variables: (input: Input) => ({ input }),
          root: { insert: { select: ({ data }) => data.apply.row } }
        }),
        optimistic: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          variables: (input: Input) => ({ input }),
          optimistic: { root: { insert: { select: ({ tempId }) => ({ id: tempId, value: 'optimistic' }) } } },
          root: { insert: { select: ({ data }) => data.apply.row } }
        })
      })
    });

    const removed = Model.actions.tracked.run({ value: 'removed' });
    await settle();
    const removedRecord = getOperationState().pending()[0]!;
    getApplyRuntime().commit(createCommitEnvelope([], [{ kind: 'remove', operationId: removedRecord.operationId }]));
    pendingResponses.shift()!({ apply: { row: { id: 'removed', value: 'removed' } } });
    await expect(removed).resolves.toBeNull();

    const trackedMismatch = Model.actions.tracked.run({ value: 'tracked-mismatch' });
    await settle();
    const trackedRecord = getOperationState().pending()[0]!;
    const { status: trackedStatus, ...trackedOperation } = trackedRecord;
    void trackedStatus;
    getApplyRuntime().commit(createCommitEnvelope([], [{ kind: 'begin', operation: { ...trackedOperation, tempIds: ['temp-corrupt'] } }]));
    pendingResponses.shift()!({ apply: { row: { id: 'tracked', value: 'tracked' } } });
    await expect(trackedMismatch).resolves.toBeNull();

    const optimisticMismatch = Model.actions.optimistic.run({ value: 'optimistic-mismatch' });
    await settle();
    const optimisticRecord = getOperationState().pending().find(record => record.actionKey.endsWith(':optimistic'))!;
    const { status: optimisticStatus, ...optimisticOperation } = optimisticRecord;
    void optimisticStatus;
    getApplyRuntime().commit(createCommitEnvelope([], [{ kind: 'begin', operation: { ...optimisticOperation, tempIds: ['temp-other'] } }]));
    pendingResponses.shift()!({ apply: { row: { id: 'server', value: 'server' } } });
    await expect(optimisticMismatch).resolves.toBeNull();
    expect(Model.find('server')).toBeUndefined();
  });

  it('keeps request dedupe, failure, and retry selection model-owned', async () => {
    const receivedErrors: Error[] = [];
    let failTracked = true;
    const transport = createMockTransport({
      mutation: async <TData,>(operation: Parameters<DbTransport['mutation']>[0]) => {
        const input = (operation.variables as Variables).input;
        if (input.value === 'tracked-failure' && failTracked) {
          failTracked = false;
          return Promise.reject('tracked transport failed');
        }
        return { data: { apply: { row: { id: input.id ?? 'server', value: input.value } } } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const Model = defineModel('SpecActionRetrySelection', {
      schema: RowSchema,
      actions: owner => ({
        apply: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          variables: (input: Input) => ({ input }),
          optimistic: { root: { update: { select: ({ input }) => ({ id: input.id!, patch: { value: input.value } }) } } },
          root: { update: { select: ({ data }) => ({ id: data.apply.row.id, patch: { value: data.apply.row.value } }) } }
        }),
        other: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          variables: (input: Input) => ({ input }),
          optimistic: { root: { update: { select: ({ input }) => ({ id: input.id!, patch: { value: input.value } }) } } },
          root: { update: { select: ({ data }) => ({ id: data.apply.row.id, patch: { value: data.apply.row.value } }) } }
        }),
        untracked: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          dedupe: false,
          variables: (input: Input) => ({ input }),
          root: { insert: { select: ({ data }) => data.apply.row } }
        }),
        tracked: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          dedupe: { key: input => input.value },
          variables: (input: Input) => ({ input }),
          root: { insert: { select: ({ data }) => data.apply.row } },
          error: error => receivedErrors.push(error)
        })
      })
    });
    Model.insert({ id: 'row-1', value: 'base' });

    await expect(Model.actions.untracked.run({ value: 'untracked' })).resolves.toEqual({ row: { id: 'server', value: 'untracked' } });
    await expect(Model.actions.tracked.run({ value: 'tracked-failure' })).rejects.toBe('tracked transport failed');
    expect(receivedErrors).toEqual([new Error('tracked transport failed')]);

    const record = (
      operationId: string,
      actionKey: string,
      createdAt: number,
      input: Input
    ) => ({
      operationId,
      actionKey,
      actionMode: 'request' as const,
      model: Model.key,
      tempIds: [],
      rowIds: ['row-1'],
      intent: 'patch' as const,
      input,
      createdAt
    });
    const addFailed = (operation: ReturnType<typeof record>): void => {
      getApplyRuntime().commit(createCommitEnvelope([], [{ kind: 'begin', operation }]));
      getApplyRuntime().commit(createCommitEnvelope([], [{ kind: 'close', operationId: operation.operationId, status: 'failed' }]));
    };
    addFailed(record('other', `${Model.key}:other`, 30, { id: 'row-1', value: 'other' }));
    addFailed(record('latest', `${Model.key}:apply`, 20, { id: 'row-1', value: 'latest' }));
    addFailed(record('earlier', `${Model.key}:apply`, 10, { id: 'row-1', value: 'earlier' }));

    await expect(Model.actions.apply.retry('row-1')).resolves.toEqual({ row: { id: 'row-1', value: 'latest' } });
    expect(Model.find('row-1')).toEqual({ id: 'row-1', value: 'latest' });

    addFailed(record('no-optimistic', `${Model.key}:untracked`, 40, { id: 'row-1', value: 'ignored' }));
    const untrackedRetry = Model.actions.untracked as unknown as { retry(rowId: string): Promise<unknown> };
    await expect(untrackedRetry.retry('row-1')).resolves.toBeNull();
  });

  it('does not start transport when an optimistic commit resets the runtime', async () => {
    const transport = createMockTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const Model = defineModel('SpecActionOptimisticCommitReset', {
      schema: RowSchema,
      maintenance: { dropTempRowsAfterMs: 60_000 },
      actions: owner => ({
        apply: owner.gql.action(document, {
          mode: 'request',
          result: 'apply',
          variables: (input: Input) => ({ input }),
          optimistic: { root: { insert: { select: ({ tempId }) => ({ id: tempId, value: 'optimistic' }) } } },
          root: { insert: { select: ({ data }) => data.apply.row } }
        })
      })
    });
    const unsubscribe = getCommitBus().subscribeAll(() => resetRuntime());

    await expect(Model.actions.apply.run({ value: 'reset' })).resolves.toBeNull();

    unsubscribe();
    expect(transport.calls).toHaveLength(0);
  });
});
