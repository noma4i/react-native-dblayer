import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import {
  configureDb,
  defineModel,
  defineShape,
  f,
  getCommitBus,
  resetRuntime,
  type WritePlan
} from '../../testApi';
import { createMemoryPlane, createMockTransport, settle } from '../helpers/harness';

type Job = { id: string; label: string; status: 'pending' | 'done' };
type Input = { label: string };
type TransportInput = { token: string };
type Data = { startJob: { job: Job } | null };
type Variables = { input: { label: string; token: string } };
type Context = { operationId: string; tempId: string };
type OptimisticContext = Context & { input: Input };
type ResponseContext = { input: Input; data: Data };

type Options = {
  before?: (input: Input, context: Context) => void;
  variables?: (input: Input, transportInput: TransportInput, context: Context) => Variables;
  optimisticSelect?: (context: OptimisticContext) => unknown;
  responseSelect?: (context: ResponseContext) => unknown;
  write?: (context: ResponseContext, plan: WritePlan) => void;
  track?: (context: ResponseContext) => void;
  error?: (error: Error, context: Context & { input: Input }) => void;
};

const document: TypedDocumentNode<Data, Variables> = { kind: Kind.DOCUMENT, definitions: [] };
const JobSchema = defineShape<Job>()({ label: f.str(), status: f.enum(['pending', 'done'] as const) });

const defineDurable = (key: string, options: Options = {}) =>
  defineModel(key, {
    schema: JobSchema,
    maintenance: { dropTempRowsAfterMs: 60_000 },
    actions: owner => ({
      start: owner.gql.action(document, {
        mode: 'durable',
        result: 'startJob',
        before: options.before,
        variables:
          options.variables ??
          ((input: Input, transportInput: TransportInput) => ({ input: { label: input.label, token: transportInput.token } })),
        optimistic: {
          root: {
            insert: {
              select: (options.optimisticSelect ??
                (({ input, tempId }: OptimisticContext) => ({ id: tempId, label: input.label, status: 'pending' as const }))) as never
            }
          }
        },
        root: {
          insert: {
            select: (options.responseSelect ?? (({ data }: ResponseContext) => data.startJob?.job ?? null)) as never
          }
        },
        write: options.write,
        track: options.track,
        error: options.error
      })
    })
  });

afterEach(() => resetRuntime());

describe('durable action edges', () => {
  it('rejects non-serializable and malformed optimistic inserts before commit', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const Cyclic = defineDurable('SpecDurableCyclic');
    const cyclic: Input & { self?: unknown } = { label: 'cyclic' };
    cyclic.self = cyclic;
    expect(() => Cyclic.actions.start.start(cyclic)).toThrow('action input is not JSON serializable');

    const Primitive = defineDurable('SpecDurableOptimisticPrimitive', { optimisticSelect: () => 'invalid' });
    const Multiple = defineDurable('SpecDurableOptimisticMultiple', {
      optimisticSelect: ({ tempId }) => [
        { id: tempId, label: 'first', status: 'pending' },
        { id: `${tempId}-second`, label: 'second', status: 'pending' }
      ]
    });
    const Empty = defineDurable('SpecDurableOptimisticEmpty', { optimisticSelect: () => null });

    expect(() => Primitive.actions.start.start({ label: 'primitive' })).toThrow('selector must return exactly one row');
    expect(() => Multiple.actions.start.start({ label: 'multiple' })).toThrow('selector must return exactly one row');
    expect(() => Empty.actions.start.start({ label: 'empty' })).toThrow('selector must return exactly one row');
  });

  it('makes cancel terminal for execute, resume, and repeated cancel', async () => {
    const transport = createMockTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const Model = defineDurable('SpecDurableTerminalCancel');
    const handle = Model.actions.start.start({ label: 'cancel' });

    handle.cancel();
    handle.cancel();

    await expect(handle.execute({ token: 'ignored' })).resolves.toBeNull();
    expect(Model.actions.start.resume(handle.operationId)).toBeUndefined();
    expect(Model.actions.start.resume('missing')).toBeUndefined();
    expect(transport.calls).toHaveLength(0);
  });

  it('drops an in-flight response after cancel', async () => {
    let resolveMutation!: (data: Data) => void;
    const transport = createMockTransport({
      mutation: <TData,>() =>
        new Promise<{ data: TData }>(resolve => {
          resolveMutation = data => resolve({ data: data as TData });
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const Model = defineDurable('SpecDurableCancelInFlight');
    const handle = Model.actions.start.start({ label: 'pending' });
    const pending = handle.execute({ token: 'token' });
    await settle();

    handle.cancel();
    resolveMutation({ startJob: { job: { id: 'server', label: 'server', status: 'done' } } });

    await expect(pending).resolves.toBeNull();
    expect(Model.find('server')).toBeUndefined();
  });

  it('rejects missing, empty, primitive, and multiple response roots', async () => {
    const transport = createMockTransport({
      mutation: async <TData,>() => ({ data: { startJob: { job: { id: 'server', label: 'server', status: 'done' } } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const MissingPayload = defineDurable('SpecDurableMissingPayload');
    const Empty = defineDurable('SpecDurableResponseEmpty', { responseSelect: () => null });
    const Primitive = defineDurable('SpecDurableResponsePrimitive', { responseSelect: () => 'invalid' });
    const Multiple = defineDurable('SpecDurableResponseMultiple', {
      responseSelect: ({ data }) => [data.startJob!.job, { ...data.startJob!.job, id: 'second' }]
    });

    const missingTransport = createMockTransport({ mutation: async <TData,>() => ({ data: { startJob: null } as TData }) });
    configureDb({ storage: createMemoryPlane(), transport: missingTransport });
    const missingHandle = MissingPayload.actions.start.start({ label: 'missing' });
    await expect(missingHandle.execute({ token: 'token' })).rejects.toThrow('startJob returned no data');

    configureDb({ storage: createMemoryPlane(), transport });
    await expect(Empty.actions.start.start({ label: 'empty' }).execute({ token: 'token' })).rejects.toThrow('selector must return exactly one row');
    await expect(Primitive.actions.start.start({ label: 'primitive' }).execute({ token: 'token' })).rejects.toThrow('selector must return exactly one row');
    await expect(Multiple.actions.start.start({ label: 'multiple' }).execute({ token: 'token' })).rejects.toThrow('selector must return exactly one row');
  });

  it('does not send durable transport after before or variables resets runtime', async () => {
    const transport = createMockTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const Before = defineDurable('SpecDurableBeforeReset', { before: () => resetRuntime() });
    const Variables = defineDurable('SpecDurableVariablesReset', {
      variables: (input, transportInput) => {
        resetRuntime();
        return { input: { label: input.label, token: transportInput.token } };
      }
    });

    await expect(Before.actions.start.start({ label: 'before' }).execute({ token: 'token' })).resolves.toBeNull();
    await expect(Variables.actions.start.start({ label: 'variables' }).execute({ token: 'token' })).resolves.toBeNull();
    expect(transport.calls).toHaveLength(0);
  });

  it('drops a durable response when transport resets the runtime before returning', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        mutation: async <TData,>() => {
          resetRuntime();
          return { data: { startJob: { job: { id: 'server', label: 'server', status: 'done' } } } as TData };
        }
      })
    });
    const Model = defineDurable('SpecDurableTransportReset');

    await expect(Model.actions.start.start({ label: 'transport' }).execute({ token: 'token' })).resolves.toBeNull();
  });

  it('fences response planning, write compilation, commit, invalidation, and tracking resets', async () => {
    const transport = createMockTransport({
      mutation: async <TData,>() => ({ data: { startJob: { job: { id: 'server', label: 'server', status: 'done' } } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const Response = defineDurable('SpecDurableResponseReset', {
      responseSelect: ({ data }) => {
        resetRuntime();
        return data.startJob!.job;
      }
    });
    await expect(Response.actions.start.start({ label: 'response' }).execute({ token: 'token' })).resolves.toBeNull();

    const ResetScalar = f.custom<string, string>(value => {
      resetRuntime();
      return value;
    });
    const Sibling = defineModel('SpecDurableWriteResetSibling', {
      schema: defineShape<{ id: string; value: string }>()({ value: ResetScalar })
    });
    const Write = defineDurable('SpecDurableWriteReset', {
      write: (_context, plan) => plan.upsert(Sibling, { id: 'sibling', value: 'reset' })
    });
    await expect(Write.actions.start.start({ label: 'write' }).execute({ token: 'token' })).resolves.toBeNull();

    const Commit = defineDurable('SpecDurableCommitReset');
    const commitHandle = Commit.actions.start.start({ label: 'commit' });
    const unsubscribeCommit = getCommitBus().subscribeAll(() => resetRuntime());
    await expect(commitHandle.execute({ token: 'token' })).resolves.toBeNull();
    unsubscribeCommit();

    const Invalidation = defineDurable('SpecDurableInvalidationReset', {
      write: (_context, plan) => plan.invalidate({ invalidate: () => resetRuntime() })
    });
    await expect(Invalidation.actions.start.start({ label: 'invalidate' }).execute({ token: 'token' })).resolves.toBeNull();

    const Track = defineDurable('SpecDurableTrackReset', { track: () => resetRuntime() });
    await expect(Track.actions.start.start({ label: 'track' }).execute({ token: 'token' })).resolves.toBeNull();
  });

  it('contains durable callback failures and normalizes non-Error transport failures', async () => {
    const onSyncError = jest.fn();
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ mutation: async () => Promise.reject('transport failed') }),
      defaults: { onSyncError }
    });
    const errors: Error[] = [];
    const Failure = defineDurable('SpecDurableErrorCallback', {
      error: error => {
        errors.push(error);
        throw new Error('error callback failed');
      }
    });
    await expect(Failure.actions.start.start({ label: 'failure' }).execute({ token: 'token' })).rejects.toBe('transport failed');
    expect(errors).toEqual([new Error('transport failed')]);
    expect(onSyncError).toHaveBeenCalledWith(expect.any(Error), {
      source: 'action',
      model: Failure.key,
      key: 'error'
    });

    const successTransport = createMockTransport({
      mutation: async <TData,>() => ({ data: { startJob: { job: { id: 'server', label: 'server', status: 'done' } } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport: successTransport, defaults: { onSyncError } });
    const Callbacks = defineDurable('SpecDurableCallbackFailure', {
      write: (_context, plan) => plan.invalidate({ invalidate: () => { throw new Error('invalidate failed'); } }),
      track: () => { throw new Error('track failed'); }
    });
    const callbackHandle = Callbacks.actions.start.start({ label: 'callbacks' });
    await expect(callbackHandle.execute({ token: 'token' })).resolves.toEqual({
      job: { id: 'server', label: 'server', status: 'done' }
    });
    expect(Callbacks.actions.start.resume(callbackHandle.operationId)).toBeUndefined();
    expect(onSyncError).toHaveBeenCalledWith(expect.any(Error), {
      source: 'action',
      model: Callbacks.key,
      key: 'write.invalidate'
    });
    expect(onSyncError).toHaveBeenCalledWith(expect.any(Error), {
      source: 'action',
      model: Callbacks.key,
      key: 'track'
    });

    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ mutation: async () => Promise.reject(new Error('error transport failed')) })
    });
    const ErrorFailure = defineDurable('SpecDurableErrorObject', { error: error => errors.push(error) });
    await expect(ErrorFailure.actions.start.start({ label: 'error' }).execute({ token: 'token' })).rejects.toThrow('error transport failed');
    expect(errors.at(-1)).toEqual(new Error('error transport failed'));
  });

  it('drops a stale durable rejection and a retry fenced by its reopen commit', async () => {
    let rejectMutation!: (error: Error) => void;
    const transport = createMockTransport({
      mutation: <TData,>() =>
        new Promise<{ data: TData }>((_resolve, reject) => {
          rejectMutation = reject;
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const Model = defineDurable('SpecDurableStaleFailure');
    const staleHandle = Model.actions.start.start({ label: 'stale' });
    const stale = staleHandle.execute({ token: 'token' });
    await settle();
    resetRuntime();
    rejectMutation(new Error('stale failure'));
    await expect(stale).resolves.toBeNull();

    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({ mutation: async () => Promise.reject(new Error('first failure')) }) });
    const Retry = defineDurable('SpecDurableRetryFence');
    const retryHandle = Retry.actions.start.start({ label: 'retry' });
    await expect(retryHandle.execute({ token: 'first' })).rejects.toThrow('first failure');
    const unsubscribeCommit = getCommitBus().subscribeAll(() => resetRuntime());
    await expect(retryHandle.execute({ token: 'second' })).resolves.toBeNull();
    unsubscribeCommit();
  });
});
