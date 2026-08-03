import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { act } from 'react';
import {
  bootDb,
  configureDb,
  createCommitEnvelope,
  defineModel,
  defineShape,
  f,
  getApplyRuntime,
  getInternalModelHandle,
  getOperationState,
  hasMany,
  resetRuntime,
  suspendDb
} from '../../testApi';
import type { DbTransport } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics, renderCounted, settle } from '../helpers/harness';

type Job = {
  id: string;
  label: string;
  status: 'queued' | 'pending' | 'done';
};

type StartInput = { label: string };
type StartData = { startJob: { job: Job } };
type StartVariables = { input: StartInput };
type StatusInput = { id: string };
type PatchInput = { id: string; status: Job['status'] };
type StatusData = { jobStatus: { id: string; status: Job['status'] } };
type StatusVariables = { id: string };
type CascadeChild = { id: string; parentId: string; label: string };
type CorrelationMessage = { id: string; body: string; chatId: string; status: 'pending' | 'sent' };
type CorrelationInput = { body: string; chatId: string };
type CorrelationData = { sendMessage: { message: CorrelationMessage } };
type CorrelationVariables = { input: CorrelationInput };
type MemoryPlane = ReturnType<typeof createMemoryPlane>;
type Reader = { renders(): number; unmount(): void };

const startDocument: TypedDocumentNode<StartData, StartVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const statusDocument: TypedDocumentNode<StatusData, StatusVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const correlationDocument: TypedDocumentNode<CorrelationData, CorrelationVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const JobSchema = defineShape<Job>()({
  label: f.str(),
  status: f.enum(['queued', 'pending', 'done'] as const)
});
const CorrelationMessageSchema = defineShape<CorrelationMessage>()({
  body: f.str(),
  chatId: f.str(),
  status: f.enum(['pending', 'sent'] as const)
});
const unrelatedRow: Job = { id: 'unrelated', label: 'unrelated', status: 'queued' };

const workSnapshot = (storage: MemoryPlane, affected: Reader, unrelated: Reader) => ({
  wal: storage.keys('dbl:journal:').length,
  commits: diagnostics().snapshot().commits,
  affectedTicks: affected.renders(),
  unrelatedTicks: unrelated.renders()
});

const expectWork = (
  storage: MemoryPlane,
  affected: Reader,
  unrelated: Reader,
  before: ReturnType<typeof workSnapshot>,
  expected: { wal: number; commits: number; affectedTicks: number }
): void => {
  expect(storage.keys('dbl:journal:').length - before.wal).toBe(expected.wal);
  expect(diagnostics().snapshot().commits - before.commits).toBe(expected.commits);
  expect(affected.renders() - before.affectedTicks).toBe(expected.affectedTicks);
  expect(unrelated.renders() - before.unrelatedTicks).toBe(0);
};

const defineUnrelated = (key: string) => {
  const model = defineModel(key, {
    schema: JobSchema,
    actions: () => ({})
  });
  model.insert(unrelatedRow);
  return model;
};

describe('action modes', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs a request through its response root with one envelope', async () => {
    const calls: string[] = [];
    const storage = createMemoryPlane();
    const transport = createMockTransport({
      mutation: async <TData,>(operation: Parameters<DbTransport['mutation']>[0]) => {
        calls.push('transport');
        expect(operation.mutation).toBe(startDocument);
        expect(operation.variables).toEqual({ input: { label: 'request' } });
        return { data: { startJob: { job: { id: 'request-server', label: 'request', status: 'done' } } } as TData };
      }
    });
    configureDb({ storage, transport });
    const Unrelated = defineUnrelated('SpecActionModeRequestUnrelated');
    const JobModel = defineModel('SpecActionModeRequest', {
      schema: JobSchema,
      actions: owner => ({
        start: owner.gql.action(startDocument, {
          mode: 'request',
          result: 'startJob',
          variables: (input: StartInput) => ({ input }),
          root: { insert: { select: ({ data }) => data.startJob.job } },
          before: () => calls.push('before'),
          track: () => calls.push('track'),
          error: () => calls.push('error')
        })
      })
    });
    const affected = renderCounted(() => JobModel.useFind('request-server'));
    const unrelated = renderCounted(() => Unrelated.useFind(unrelatedRow.id));
    const before = workSnapshot(storage, affected, unrelated);

    await act(async () => {
      await JobModel.actions.start.run({ label: 'request' });
    });

    expect(JobModel.find('request-server')).toEqual({ id: 'request-server', label: 'request', status: 'done' });
    expect(calls).toEqual(['before', 'transport', 'track']);
    expectWork(storage, affected, unrelated, before, { wal: 1, commits: 1, affectedTicks: 1 });
    affected.unmount();
    unrelated.unmount();
  });

  it('keeps the later pending patch when an earlier request fails', async () => {
    let attempt = 0;
    let rejectFirst!: (reason?: unknown) => void;
    const firstResponse = new Promise<never>((_, reject) => {
      rejectFirst = reject;
    });
    let resolveSecond!: (value: { data: StatusData }) => void;
    const secondResponse = new Promise<{ data: StatusData }>(resolve => {
      resolveSecond = resolve;
    });
    const storage = createMemoryPlane();
    const transport = createMockTransport({
      mutation: async <TData,>() => {
        attempt += 1;
        if (attempt === 1) {
          await firstResponse;
          throw new Error('first concurrent update failed');
        }
        const response = await secondResponse;
        return { data: response.data as TData };
      }
    });
    configureDb({ storage, transport });
    const Unrelated = defineUnrelated('SpecActionModeConcurrentPatchUnrelated');
    const JobModel = defineModel('SpecActionModeConcurrentPatch', {
      schema: JobSchema,
      actions: owner => ({
        change: owner.gql.action(statusDocument, {
          mode: 'request',
          result: 'jobStatus',
          variables: (input: PatchInput) => ({ id: input.id }),
          optimistic: {
            root: {
              update: {
                select: ({ input }) => ({ id: input.id, patch: { status: input.status } })
              }
            }
          },
          root: {
            update: {
              select: ({ data }) => ({ id: data.jobStatus.id, patch: { status: data.jobStatus.status } })
            }
          }
        })
      })
    });
    const id = 'concurrent-patch-target';
    JobModel.insert({ id, label: 'target', status: 'queued' });
    const affected = renderCounted(() => JobModel.useFind(id));
    const unrelated = renderCounted(() => Unrelated.useFind(unrelatedRow.id));
    const before = workSnapshot(storage, affected, unrelated);
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;

    act(() => {
      first = JobModel.actions.change.run({ id, status: 'pending' });
      second = JobModel.actions.change.run({ id, status: 'done' });
    });

    expect(attempt).toBe(2);
    expect(JobModel.find(id)).toEqual({ id, label: 'target', status: 'done' });
    expectWork(storage, affected, unrelated, before, { wal: 2, commits: 2, affectedTicks: 1 });

    const failureBefore = workSnapshot(storage, affected, unrelated);
    rejectFirst(new Error('first concurrent update failed'));
    await act(async () => {
      await expect(first).rejects.toThrow('first concurrent update failed');
    });

    expect(JobModel.find(id)).toEqual({ id, label: 'target', status: 'done' });
    expectWork(storage, affected, unrelated, failureBefore, { wal: 1, commits: 1, affectedTicks: 0 });

    const responseBefore = workSnapshot(storage, affected, unrelated);
    resolveSecond({ data: { jobStatus: { id, status: 'queued' } } });
    await act(async () => {
      await second;
    });

    expect(JobModel.find(id)).toEqual({ id, label: 'target', status: 'queued' });
    expect(getOperationState().pending()).toEqual([]);
    const openOperations = getOperationState().open();
    expect(openOperations).toHaveLength(1);
    expect(openOperations[0]).toMatchObject({
      model: 'SpecActionModeConcurrentPatch',
      actionMode: 'request',
      intent: 'patch',
      rowIds: [id],
      status: 'failed'
    });
    expectWork(storage, affected, unrelated, responseBefore, { wal: 1, commits: 1, affectedTicks: 1 });
    affected.unmount();
    unrelated.unmount();
  });

  it('rejects optimistic destroy before touching a dependent cascade', async () => {
    const storage = createMemoryPlane();
    const transport = createMockTransport({
      mutation: async <TData,>() => ({
        data: { jobStatus: { id: 'cascade-parent', status: 'done' } } as TData
      })
    });
    configureDb({ storage, transport });
    const ChildModel = defineModel('SpecActionModeCascadeChild', {
      schema: defineShape<CascadeChild>()({
        parentId: f.str(),
        label: f.str()
      })
    });
    const ParentModel = defineModel('SpecActionModeCascadeParent', {
      schema: JobSchema,
      associations: () => ({
        children: hasMany<Job, CascadeChild>(ChildModel, { foreignKey: 'parentId', dependent: 'destroy' })
      }),
      actions: owner => ({
        destroy: owner.gql.action(statusDocument, {
          mode: 'request',
          result: 'jobStatus',
          variables: (input: StatusInput) => ({ id: input.id }),
          optimistic: { root: { destroy: { select: ({ input }) => input.id } } },
          root: { destroy: { select: ({ data }) => data.jobStatus.id } }
        })
      })
    });
    ParentModel.insert({ id: 'cascade-parent', label: 'parent', status: 'queued' });
    ChildModel.insert({ id: 'cascade-child', parentId: 'cascade-parent', label: 'child' });
    const parentReader = renderCounted(() => ParentModel.useFind('cascade-parent'));
    const childReader = renderCounted(() => ChildModel.useFind('cascade-child'));
    const before = workSnapshot(storage, parentReader, childReader);

    await expect(ParentModel.actions.destroy.run({ id: 'cascade-parent' })).rejects.toThrow(
      'SpecActionModeCascadeParent: optimistic destroy is not supported on models with dependent cascades - rollback cannot restore cascaded children'
    );

    expect(transport.calls).toHaveLength(0);
    expect(ParentModel.find('cascade-parent')).toEqual({ id: 'cascade-parent', label: 'parent', status: 'queued' });
    expect(ChildModel.find('cascade-child')).toEqual({ id: 'cascade-child', parentId: 'cascade-parent', label: 'child' });
    expectWork(storage, parentReader, childReader, before, { wal: 0, commits: 0, affectedTicks: 0 });
    parentReader.unmount();
    childReader.unmount();
  });

  it('correlates request inserts only through their own action rules', async () => {
    const storage = createMemoryPlane();
    const transport = createMockTransport({
      mutation: async <TData,>() => new Promise<{ data: TData }>(() => {})
    });
    configureDb({ storage, transport });
    const MessageModel = defineModel('SpecActionModeCorrelation', {
      schema: CorrelationMessageSchema,
      maintenance: { dropTempRowsAfterMs: 60_000 },
      actions: owner => ({
        byBody: owner.gql.action(correlationDocument, {
          mode: 'request',
          result: 'sendMessage',
          variables: (input: CorrelationInput) => ({ input }),
          optimistic: {
            root: {
              insert: {
                select: ({ input, tempId }) => ({ id: tempId, body: input.body, chatId: input.chatId, status: 'pending' as const })
              }
            },
            correlate: { fields: ['body'] }
          },
          root: { insert: { select: ({ data }) => data.sendMessage.message } }
        }),
        byChatId: owner.gql.action(correlationDocument, {
          mode: 'request',
          result: 'sendMessage',
          variables: (input: CorrelationInput) => ({ input }),
          optimistic: {
            root: {
              insert: {
                select: ({ input, tempId }) => ({ id: tempId, body: input.body, chatId: input.chatId, status: 'pending' as const })
              }
            },
            correlate: { fields: ['chatId'] }
          },
          root: { insert: { select: ({ data }) => data.sendMessage.message } }
        })
      })
    });
    let bodyRequest!: Promise<unknown>;
    let chatIdRequest!: Promise<unknown>;
    act(() => {
      bodyRequest = MessageModel.actions.byBody.run({ body: 'body-a', chatId: 'chat-a' });
      chatIdRequest = MessageModel.actions.byChatId.run({ body: 'body-b', chatId: 'chat-b' });
    });
    void bodyRequest;
    void chatIdRequest;

    const bodyOperation = getOperationState().open().find(operation => operation.actionKey === 'SpecActionModeCorrelation:byBody');
    const chatIdOperation = getOperationState().open().find(operation => operation.actionKey === 'SpecActionModeCorrelation:byChatId');
    expect(bodyOperation).toBeDefined();
    expect(chatIdOperation).toBeDefined();
    const bodyTempId = bodyOperation!.tempIds[0]!;
    const chatIdTempId = chatIdOperation!.tempIds[0]!;
    const reader = renderCounted(() => [
      MessageModel.useFind(bodyTempId),
      MessageModel.useFind(chatIdTempId),
      MessageModel.useFind('server-chat')
    ]);
    const beforeCrossLanding = reader.renders();
    const crossPlan = getInternalModelHandle(MessageModel).planRows([
      { id: 'server-cross', body: 'body-b', chatId: 'chat-a', status: 'sent' }
    ]);

    expect(crossPlan.some(operation => operation.kind === 'destroy' && operation.ids.some(id => id === bodyTempId || id === chatIdTempId))).toBe(false);
    expect(reader.renders() - beforeCrossLanding).toBe(0);
    expect(MessageModel.find(bodyTempId)).toMatchObject({ body: 'body-a', chatId: 'chat-a', status: 'pending' });
    expect(MessageModel.find(chatIdTempId)).toMatchObject({ body: 'body-b', chatId: 'chat-b', status: 'pending' });
    expect(getOperationState().get(bodyOperation!.operationId)).toMatchObject({ status: 'pending' });
    expect(getOperationState().get(chatIdOperation!.operationId)).toMatchObject({ status: 'pending' });

    const acceptedPlan = getInternalModelHandle(MessageModel).planRows([
      { id: 'server-chat', body: 'confirmed-b', chatId: 'chat-b', status: 'sent' }
    ]);
    act(() => {
      getApplyRuntime().commit(createCommitEnvelope(acceptedPlan));
    });

    expect(reader.renders() - beforeCrossLanding).toBe(1);
    expect(MessageModel.find(bodyTempId)).toMatchObject({ body: 'body-a', chatId: 'chat-a', status: 'pending' });
    expect(MessageModel.find(chatIdTempId)).toBeUndefined();
    expect(MessageModel.find('server-chat')).toEqual({ id: 'server-chat', body: 'confirmed-b', chatId: 'chat-b', status: 'sent' });
    expect(getOperationState().get(bodyOperation!.operationId)).toMatchObject({ status: 'pending' });
    expect(getOperationState().get(chatIdOperation!.operationId)).toMatchObject({ status: 'committed' });
    expect(getOperationState().open()).toEqual([
      expect.objectContaining({ actionKey: 'SpecActionModeCorrelation:byBody', status: 'pending', tempIds: [bodyTempId] })
    ]);
    reader.unmount();
  });

  it('keeps a failed optimistic insert and retries the same operation and temp row', async () => {
    let attempt = 0;
    let resolveRetry!: (value: { data: StartData }) => void;
    const retryResponse = new Promise<{ data: StartData }>(resolve => {
      resolveRetry = resolve;
    });
    const storage = createMemoryPlane();
    const transport = createMockTransport({
      mutation: async <TData,>() => {
        attempt += 1;
        if (attempt === 1) throw new Error('request failed');
        const response = await retryResponse;
        return { data: response.data as TData };
      }
    });
    configureDb({ storage, transport });
    const Unrelated = defineUnrelated('SpecActionModeRetryUnrelated');
    let tempId = '';
    const JobModel = defineModel('SpecActionModeRetry', {
      schema: JobSchema,
      maintenance: { dropTempRowsAfterMs: 60_000 },
      actions: owner => ({
        create: owner.gql.action(startDocument, {
          mode: 'request',
          result: 'startJob',
          variables: (input: StartInput) => ({ input }),
          optimistic: {
            root: {
              insert: {
                select: ({ input, tempId: nextTempId }) => {
                  tempId = nextTempId;
                  return { id: nextTempId, label: input.label, status: 'pending' as const };
                }
              }
            }
          },
          root: { insert: { select: ({ data }) => data.startJob.job } }
        })
      })
    });
    const affected = renderCounted(() => JobModel.where({}).use().data);
    const unrelated = renderCounted(() => Unrelated.useFind(unrelatedRow.id));
    const failedBefore = workSnapshot(storage, affected, unrelated);

    await act(async () => {
      await expect(JobModel.actions.create.run({ label: 'retry' })).rejects.toThrow('request failed');
    });

    const failedOperation = getOperationState().open()[0];
    expect(failedOperation).toMatchObject({ status: 'failed', tempIds: [tempId] });
    expect(JobModel.find(tempId)).toEqual({ id: tempId, label: 'retry', status: 'pending' });
    expect(JobModel.operation(tempId).read()).toMatchObject({ pending: false, failed: true });
    expectWork(storage, affected, unrelated, failedBefore, { wal: 2, commits: 2, affectedTicks: 1 });

    const retryBefore = workSnapshot(storage, affected, unrelated);
    let retry!: Promise<unknown>;
    act(() => {
      retry = JobModel.actions.create.retry(tempId);
    });
    await settle();
    expect(getOperationState().pending()[0]).toMatchObject({ operationId: failedOperation?.operationId, tempIds: [tempId] });
    expect(JobModel.where({}).read()).toEqual([{ id: tempId, label: 'retry', status: 'pending' }]);

    await act(async () => {
      resolveRetry({ data: { startJob: { job: { id: 'retry-server', label: 'retry', status: 'done' } } } });
      await retry;
    });

    expect(transport.calls).toHaveLength(2);
    expect(JobModel.find(tempId)).toBeUndefined();
    expect(JobModel.find('retry-server')).toEqual({ id: 'retry-server', label: 'retry', status: 'done' });
    expect(JobModel.where({}).read()).toEqual([{ id: 'retry-server', label: 'retry', status: 'done' }]);
    expectWork(storage, affected, unrelated, retryBefore, { wal: 2, commits: 2, affectedTicks: 1 });
    affected.unmount();
    unrelated.unmount();
  });

  it('discards a failed optimistic insert in one envelope', async () => {
    const storage = createMemoryPlane();
    configureDb({
      storage,
      transport: createMockTransport({ mutation: async () => Promise.reject(new Error('discard failed')) })
    });
    const Unrelated = defineUnrelated('SpecActionModeDiscardUnrelated');
    let tempId = '';
    const JobModel = defineModel('SpecActionModeDiscard', {
      schema: JobSchema,
      maintenance: { dropTempRowsAfterMs: 60_000 },
      actions: owner => ({
        create: owner.gql.action(startDocument, {
          mode: 'request',
          result: 'startJob',
          variables: (input: StartInput) => ({ input }),
          optimistic: {
            root: {
              insert: {
                select: ({ input, tempId: nextTempId }) => {
                  tempId = nextTempId;
                  return { id: nextTempId, label: input.label, status: 'pending' as const };
                }
              }
            }
          },
          root: { insert: { select: ({ data }) => data.startJob.job } }
        })
      })
    });
    await expect(JobModel.actions.create.run({ label: 'discard' })).rejects.toThrow('discard failed');
    const affected = renderCounted(() => JobModel.where({}).use().data);
    const unrelated = renderCounted(() => Unrelated.useFind(unrelatedRow.id));
    const before = workSnapshot(storage, affected, unrelated);

    act(() => JobModel.actions.create.discard(tempId));

    expect(JobModel.find(tempId)).toBeUndefined();
    expect(JobModel.operation(tempId).read()).toEqual({ pending: false, failed: false, unsyncedChanges: undefined });
    expectWork(storage, affected, unrelated, before, { wal: 1, commits: 1, affectedTicks: 1 });
    affected.unmount();
    unrelated.unmount();
  });

  it.each([
    ['update', 1],
    ['destroy', 1]
  ] as const)('rolls back an optimistic %s after transport error', async (name, expectedTicks) => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport({ mutation: async () => Promise.reject(new Error(`${name} failed`)) }) });
    const Unrelated = defineUnrelated(`SpecActionMode${name}Unrelated`);
    const JobModel = name === 'update'
      ? defineModel(`SpecActionMode${name}`, {
          schema: JobSchema,
          actions: owner => ({
            change: owner.gql.action(statusDocument, {
              mode: 'request',
              result: 'jobStatus',
              variables: (input: StatusInput) => ({ id: input.id }),
              optimistic: {
                root: {
                  update: { select: ({ input }) => ({ id: input.id, patch: { status: 'pending' as const } }) }
                }
              },
              root: { update: { select: ({ input }) => ({ id: input.id, patch: { status: 'done' } }) } }
            })
          })
        })
      : defineModel(`SpecActionMode${name}`, {
          schema: JobSchema,
          actions: owner => ({
            change: owner.gql.action(statusDocument, {
              mode: 'request',
              result: 'jobStatus',
              variables: (input: StatusInput) => ({ id: input.id }),
              optimistic: { root: { destroy: { select: ({ input }) => input.id } } },
              root: { destroy: { select: ({ input }) => input.id } }
            })
          })
        });
    JobModel.insert({ id: `${name}-job`, label: name, status: 'queued' });
    const affected = renderCounted(() => JobModel.useFind(`${name}-job`));
    const unrelated = renderCounted(() => Unrelated.useFind(unrelatedRow.id));
    const before = workSnapshot(storage, affected, unrelated);

    await act(async () => {
      await expect(JobModel.actions.change.run({ id: `${name}-job` })).rejects.toThrow(`${name} failed`);
    });

    expect(JobModel.find(`${name}-job`)).toEqual({ id: `${name}-job`, label: name, status: 'queued' });
    expect(JobModel.operation(`${name}-job`).read()).toMatchObject({ pending: false, failed: true });
    expectWork(storage, affected, unrelated, before, { wal: 2, commits: 2, affectedTicks: expectedTicks });
    affected.unmount();
    unrelated.unmount();
  });

  it('restores a pending optimistic update and its scoped membership after process restart', async () => {
    let resolveTransport!: (value: { data: StatusData }) => void;
    const pendingResponse = new Promise<{ data: StatusData }>(resolve => {
      resolveTransport = resolve;
    });
    const storage = createMemoryPlane();
    const firstTransport = createMockTransport({
      mutation: async <TData,>() => {
        const response = await pendingResponse;
        return { data: response.data as TData };
      }
    });
    configureDb({ storage, transport: firstTransport });
    const Unrelated = defineModel('SpecActionModeRestartUpdateUnrelated', { schema: JobSchema });
    const JobModel = defineModel('SpecActionModeRestartUpdate', {
      schema: JobSchema,
      relations: () => ({
        byLabel: ({ by: { label: 'label' }, sort: 'server-order' })
      }),
      actions: owner => ({
        change: owner.gql.action(statusDocument, {
          mode: 'request',
          result: 'jobStatus',
          variables: (input: StatusInput) => ({ id: input.id }),
          optimistic: {
            root: {
              update: { select: ({ input }) => ({ id: input.id, patch: { status: 'pending' as const } }) }
            }
          },
          root: { update: { select: ({ data }) => ({ id: data.jobStatus.id, patch: { status: data.jobStatus.status } }) } }
        })
      })
    });
    await act(async () => {
      await bootDb();
    });
    Unrelated.insert(unrelatedRow);
    const preActionRows: Job[] = [
      { id: 'update-before', label: 'target', status: 'queued' },
      { id: 'update-target', label: 'target', status: 'queued' },
      { id: 'update-after', label: 'target', status: 'done' }
    ];
    JobModel.byLabel({ label: 'target' }).seed(preActionRows);
    const affected = renderCounted(() => JobModel.byLabel({ label: 'target' }).use().data);
    const unrelated = renderCounted(() => Unrelated.useFind(unrelatedRow.id));
    const before = workSnapshot(storage, affected, unrelated);

    let request!: ReturnType<typeof JobModel.actions.change.run>;
    act(() => {
      request = JobModel.actions.change.run({ id: 'update-target' });
    });

    expect(JobModel.find('update-target')).toEqual({ id: 'update-target', label: 'target', status: 'pending' });
    expect(JobModel.byLabel({ label: 'target' }).read().map(row => row.id)).toEqual(['update-before', 'update-target', 'update-after']);
    expectWork(storage, affected, unrelated, before, { wal: 1, commits: 1, affectedTicks: 1 });

    suspendDb();
    affected.unmount();
    unrelated.unmount();

    const restartedTransport = createMockTransport();
    configureDb({ storage, transport: restartedTransport });
    const RestartedUnrelated = defineModel('SpecActionModeRestartUpdateUnrelated', { schema: JobSchema });
    const RestartedJobModel = defineModel('SpecActionModeRestartUpdate', {
      schema: JobSchema,
      relations: () => ({
        byLabel: ({ by: { label: 'label' }, sort: 'server-order' })
      }),
      actions: owner => ({
        change: owner.gql.action(statusDocument, {
          mode: 'request',
          result: 'jobStatus',
          variables: (input: StatusInput) => ({ id: input.id }),
          optimistic: {
            root: {
              update: { select: ({ input }) => ({ id: input.id, patch: { status: 'pending' as const } }) }
            }
          },
          root: { update: { select: ({ data }) => ({ id: data.jobStatus.id, patch: { status: data.jobStatus.status } }) } }
        })
      })
    });
    await act(async () => {
      await bootDb();
    });

    expect(RestartedJobModel.find('update-target')).toEqual(preActionRows[1]);
    expect(RestartedJobModel.byLabel({ label: 'target' }).read()).toEqual(preActionRows);
    expect(RestartedUnrelated.find(unrelatedRow.id)).toEqual(unrelatedRow);
    expect(getOperationState().pending()).toEqual([]);
    expect(getOperationState().open()).toEqual([]);
    expect(restartedTransport.calls).toHaveLength(0);

    const restartedAffected = renderCounted(() => RestartedJobModel.byLabel({ label: 'target' }).use().data);
    const restartedUnrelated = renderCounted(() => RestartedUnrelated.useFind(unrelatedRow.id));
    const lateResponseBefore = workSnapshot(storage, restartedAffected, restartedUnrelated);
    const restoredTarget = RestartedJobModel.find('update-target');
    const restoredMembership = RestartedJobModel.byLabel({ label: 'target' }).read();
    resolveTransport({ data: { jobStatus: { id: 'update-target', status: 'done' } } });
    await act(async () => {
      await expect(request).resolves.toBeNull();
    });
    expect(RestartedJobModel.find('update-target')).toEqual(restoredTarget);
    expect(RestartedJobModel.byLabel({ label: 'target' }).read()).toEqual(restoredMembership);
    expectWork(storage, restartedAffected, restartedUnrelated, lateResponseBefore, { wal: 0, commits: 0, affectedTicks: 0 });
    restartedAffected.unmount();
    restartedUnrelated.unmount();
  });

  it('restores a pending optimistic destroy and its scoped membership after process restart', async () => {
    let resolveTransport!: (value: { data: StatusData }) => void;
    const pendingResponse = new Promise<{ data: StatusData }>(resolve => {
      resolveTransport = resolve;
    });
    const storage = createMemoryPlane();
    const firstTransport = createMockTransport({
      mutation: async <TData,>() => {
        const response = await pendingResponse;
        return { data: response.data as TData };
      }
    });
    configureDb({ storage, transport: firstTransport });
    const Unrelated = defineModel('SpecActionModeRestartDestroyUnrelated', { schema: JobSchema });
    const JobModel = defineModel('SpecActionModeRestartDestroy', {
      schema: JobSchema,
      relations: () => ({
        byLabel: ({ by: { label: 'label' }, sort: 'server-order' })
      }),
      actions: owner => ({
        change: owner.gql.action(statusDocument, {
          mode: 'request',
          result: 'jobStatus',
          variables: (input: StatusInput) => ({ id: input.id }),
          optimistic: { root: { destroy: { select: ({ input }) => input.id } } },
          root: { destroy: { select: ({ data }) => data.jobStatus.id } }
        })
      })
    });
    await act(async () => {
      await bootDb();
    });
    Unrelated.insert(unrelatedRow);
    const preActionRows: Job[] = [
      { id: 'destroy-before', label: 'target', status: 'queued' },
      { id: 'destroy-target', label: 'target', status: 'queued' },
      { id: 'destroy-after', label: 'target', status: 'done' }
    ];
    JobModel.byLabel({ label: 'target' }).seed(preActionRows);
    const affected = renderCounted(() => JobModel.byLabel({ label: 'target' }).use().data);
    const unrelated = renderCounted(() => Unrelated.useFind(unrelatedRow.id));
    const before = workSnapshot(storage, affected, unrelated);

    let request!: ReturnType<typeof JobModel.actions.change.run>;
    act(() => {
      request = JobModel.actions.change.run({ id: 'destroy-target' });
    });

    expect(JobModel.find('destroy-target')).toBeUndefined();
    expect(JobModel.byLabel({ label: 'target' }).read().map(row => row.id)).toEqual(['destroy-before', 'destroy-after']);
    expectWork(storage, affected, unrelated, before, { wal: 1, commits: 1, affectedTicks: 1 });

    suspendDb();
    affected.unmount();
    unrelated.unmount();

    const restartedTransport = createMockTransport();
    configureDb({ storage, transport: restartedTransport });
    const RestartedUnrelated = defineModel('SpecActionModeRestartDestroyUnrelated', { schema: JobSchema });
    const RestartedJobModel = defineModel('SpecActionModeRestartDestroy', {
      schema: JobSchema,
      relations: () => ({
        byLabel: ({ by: { label: 'label' }, sort: 'server-order' })
      }),
      actions: owner => ({
        change: owner.gql.action(statusDocument, {
          mode: 'request',
          result: 'jobStatus',
          variables: (input: StatusInput) => ({ id: input.id }),
          optimistic: { root: { destroy: { select: ({ input }) => input.id } } },
          root: { destroy: { select: ({ data }) => data.jobStatus.id } }
        })
      })
    });
    await act(async () => {
      await bootDb();
    });

    expect(RestartedJobModel.find('destroy-target')).toEqual(preActionRows[1]);
    expect(RestartedJobModel.byLabel({ label: 'target' }).read()).toEqual(preActionRows);
    expect(RestartedUnrelated.find(unrelatedRow.id)).toEqual(unrelatedRow);
    expect(getOperationState().pending()).toEqual([]);
    expect(getOperationState().open()).toEqual([]);
    expect(restartedTransport.calls).toHaveLength(0);

    const restartedAffected = renderCounted(() => RestartedJobModel.byLabel({ label: 'target' }).use().data);
    const restartedUnrelated = renderCounted(() => RestartedUnrelated.useFind(unrelatedRow.id));
    const lateResponseBefore = workSnapshot(storage, restartedAffected, restartedUnrelated);
    const restoredTarget = RestartedJobModel.find('destroy-target');
    const restoredMembership = RestartedJobModel.byLabel({ label: 'target' }).read();
    resolveTransport({ data: { jobStatus: { id: 'destroy-target', status: 'done' } } });
    await act(async () => {
      await expect(request).resolves.toBeNull();
    });
    expect(RestartedJobModel.find('destroy-target')).toEqual(restoredTarget);
    expect(RestartedJobModel.byLabel({ label: 'target' }).read()).toEqual(restoredMembership);
    expectWork(storage, restartedAffected, restartedUnrelated, lateResponseBefore, { wal: 0, commits: 0, affectedTicks: 0 });
    restartedAffected.unmount();
    restartedUnrelated.unmount();
  });

  it('closes failed optimistic update retry and discard semantics', async () => {
    let attempt = 0;
    let resolveRetry!: (value: { data: StatusData }) => void;
    const retryResponse = new Promise<{ data: StatusData }>(resolve => {
      resolveRetry = resolve;
    });
    const storage = createMemoryPlane();
    const transport = createMockTransport({
      mutation: async <TData,>() => {
        attempt += 1;
        if (attempt === 1 || attempt === 3) throw new Error(`update attempt ${attempt} failed`);
        const response = await retryResponse;
        return { data: response.data as TData };
      }
    });
    configureDb({ storage, transport });
    const Unrelated = defineModel('SpecActionModeUpdateRetryUnrelated', { schema: JobSchema });
    Unrelated.insert(unrelatedRow);
    const JobModel = defineModel('SpecActionModeUpdateRetry', {
      schema: JobSchema,
      relations: () => ({
        byLabel: ({ by: { label: 'label' }, sort: 'server-order' })
      }),
      actions: owner => ({
        change: owner.gql.action(statusDocument, {
          mode: 'request',
          result: 'jobStatus',
          variables: (input: StatusInput) => ({ id: input.id }),
          optimistic: {
            root: {
              update: { select: ({ input }) => ({ id: input.id, patch: { status: 'pending' as const } }) }
            }
          },
          root: { update: { select: ({ data }) => ({ id: data.jobStatus.id, patch: { status: data.jobStatus.status } }) } }
        })
      })
    });
    const preActionRows: Job[] = [
      { id: 'update-retry-before', label: 'target', status: 'queued' },
      { id: 'update-retry-target', label: 'target', status: 'queued' },
      { id: 'update-retry-after', label: 'target', status: 'done' }
    ];
    JobModel.byLabel({ label: 'target' }).seed(preActionRows);
    const affected = renderCounted(() => JobModel.byLabel({ label: 'target' }).use().data);
    const unrelated = renderCounted(() => Unrelated.useFind(unrelatedRow.id));
    const failedBefore = workSnapshot(storage, affected, unrelated);

    await act(async () => {
      await expect(JobModel.actions.change.run({ id: 'update-retry-target' })).rejects.toThrow('update attempt 1 failed');
    });

    expect(JobModel.find('update-retry-target')).toEqual(preActionRows[1]);
    expect(JobModel.byLabel({ label: 'target' }).read().map(row => row.id)).toEqual(['update-retry-before', 'update-retry-target', 'update-retry-after']);
    expect(JobModel.operation('update-retry-target').read()).toMatchObject({ pending: false, failed: true });
    expect(getOperationState().open()).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'failed', rowIds: ['update-retry-target'] })])
    );
    expectWork(storage, affected, unrelated, failedBefore, { wal: 2, commits: 2, affectedTicks: 1 });

    const retryBefore = workSnapshot(storage, affected, unrelated);
    let retry!: ReturnType<typeof JobModel.actions.change.retry>;
    act(() => {
      retry = JobModel.actions.change.retry('update-retry-target');
    });
    expect(attempt).toBe(2);
    expect(JobModel.find('update-retry-target')).toEqual({ id: 'update-retry-target', label: 'target', status: 'pending' });
    expect(getOperationState().pending()).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'pending', rowIds: ['update-retry-target'] })])
    );
    expectWork(storage, affected, unrelated, retryBefore, { wal: 1, commits: 1, affectedTicks: 1 });

    const responseBefore = workSnapshot(storage, affected, unrelated);
    resolveRetry({ data: { jobStatus: { id: 'update-retry-target', status: 'done' } } });
    await act(async () => {
      await retry;
    });

    expect(JobModel.find('update-retry-target')).toEqual({ id: 'update-retry-target', label: 'target', status: 'done' });
    expect(JobModel.byLabel({ label: 'target' }).read().map(row => row.id)).toEqual(['update-retry-before', 'update-retry-target', 'update-retry-after']);
    expect(getOperationState().open()).toEqual([]);
    expectWork(storage, affected, unrelated, responseBefore, { wal: 1, commits: 1, affectedTicks: 1 });

    const secondFailureBefore = workSnapshot(storage, affected, unrelated);
    await act(async () => {
      await expect(JobModel.actions.change.run({ id: 'update-retry-target' })).rejects.toThrow('update attempt 3 failed');
    });

    expect(JobModel.find('update-retry-target')).toEqual({ id: 'update-retry-target', label: 'target', status: 'done' });
    expect(JobModel.byLabel({ label: 'target' }).read().map(row => row.id)).toEqual(['update-retry-before', 'update-retry-target', 'update-retry-after']);
    expect(JobModel.operation('update-retry-target').read()).toMatchObject({ pending: false, failed: true });
    expectWork(storage, affected, unrelated, secondFailureBefore, { wal: 2, commits: 2, affectedTicks: 1 });

    const failedOperation = getOperationState().open().find(operation => operation.status === 'failed');
    expect(failedOperation).toBeDefined();
    const discardBefore = workSnapshot(storage, affected, unrelated);
    act(() => {
      JobModel.actions.change.discard('update-retry-target');
    });

    expect(JobModel.find('update-retry-target')).toEqual({ id: 'update-retry-target', label: 'target', status: 'done' });
    expect(JobModel.byLabel({ label: 'target' }).read().map(row => row.id)).toEqual(['update-retry-before', 'update-retry-target', 'update-retry-after']);
    expect(getOperationState().get(failedOperation!.operationId)).toBeUndefined();
    expect(getOperationState().open()).toEqual([]);
    expectWork(storage, affected, unrelated, discardBefore, { wal: 1, commits: 1, affectedTicks: 0 });

    const callsAfterDiscard = transport.calls.length;
    await expect(JobModel.actions.change.retry('update-retry-target')).resolves.toBeNull();
    expect(transport.calls).toHaveLength(callsAfterDiscard);
    expect(JobModel.operation('update-retry-target').read()).toEqual({ pending: false, failed: false, unsyncedChanges: undefined });
    affected.unmount();
    unrelated.unmount();
  });

  it('closes failed optimistic destroy retry and discard semantics', async () => {
    let attempt = 0;
    let resolveRetry!: (value: { data: StatusData }) => void;
    const retryResponse = new Promise<{ data: StatusData }>(resolve => {
      resolveRetry = resolve;
    });
    const storage = createMemoryPlane();
    const transport = createMockTransport({
      mutation: async <TData,>() => {
        attempt += 1;
        if (attempt === 1 || attempt === 3) throw new Error(`destroy attempt ${attempt} failed`);
        const response = await retryResponse;
        return { data: response.data as TData };
      }
    });
    configureDb({ storage, transport });
    const Unrelated = defineModel('SpecActionModeDestroyRetryUnrelated', { schema: JobSchema });
    Unrelated.insert(unrelatedRow);
    const JobModel = defineModel('SpecActionModeDestroyRetry', {
      schema: JobSchema,
      relations: () => ({
        byLabel: ({ by: { label: 'label' }, sort: 'server-order' })
      }),
      actions: owner => ({
        change: owner.gql.action(statusDocument, {
          mode: 'request',
          result: 'jobStatus',
          variables: (input: StatusInput) => ({ id: input.id }),
          optimistic: { root: { destroy: { select: ({ input }) => input.id } } },
          root: { destroy: { select: ({ data }) => data.jobStatus.id } }
        })
      })
    });
    const preActionRows: Job[] = [
      { id: 'destroy-retry-before', label: 'target', status: 'queued' },
      { id: 'destroy-retry-target', label: 'target', status: 'queued' },
      { id: 'destroy-retry-after', label: 'target', status: 'done' }
    ];
    JobModel.byLabel({ label: 'target' }).seed(preActionRows);
    const affected = renderCounted(() => JobModel.byLabel({ label: 'target' }).use().data);
    const unrelated = renderCounted(() => Unrelated.useFind(unrelatedRow.id));
    const failedBefore = workSnapshot(storage, affected, unrelated);

    await act(async () => {
      await expect(JobModel.actions.change.run({ id: 'destroy-retry-target' })).rejects.toThrow('destroy attempt 1 failed');
    });

    expect(JobModel.find('destroy-retry-target')).toEqual(preActionRows[1]);
    expect(JobModel.byLabel({ label: 'target' }).read()).toEqual(preActionRows);
    expect(JobModel.operation('destroy-retry-target').read()).toMatchObject({ pending: false, failed: true });
    expect(getOperationState().open()).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'failed', rowIds: ['destroy-retry-target'] })])
    );
    expectWork(storage, affected, unrelated, failedBefore, { wal: 2, commits: 2, affectedTicks: 1 });

    const retryBefore = workSnapshot(storage, affected, unrelated);
    let retry!: ReturnType<typeof JobModel.actions.change.retry>;
    act(() => {
      retry = JobModel.actions.change.retry('destroy-retry-target');
    });
    expect(attempt).toBe(2);
    expect(JobModel.find('destroy-retry-target')).toBeUndefined();
    expect(JobModel.byLabel({ label: 'target' }).read().map(row => row.id)).toEqual(['destroy-retry-before', 'destroy-retry-after']);
    expect(getOperationState().pending()).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'pending', rowIds: ['destroy-retry-target'] })])
    );
    expectWork(storage, affected, unrelated, retryBefore, { wal: 1, commits: 1, affectedTicks: 1 });

    const responseBefore = workSnapshot(storage, affected, unrelated);
    resolveRetry({ data: { jobStatus: { id: 'destroy-retry-target', status: 'done' } } });
    await act(async () => {
      await retry;
    });

    expect(JobModel.find('destroy-retry-target')).toBeUndefined();
    expect(JobModel.byLabel({ label: 'target' }).read().map(row => row.id)).toEqual(['destroy-retry-before', 'destroy-retry-after']);
    expect(getOperationState().open()).toEqual([]);
    expectWork(storage, affected, unrelated, responseBefore, { wal: 1, commits: 1, affectedTicks: 0 });

    const secondFailureRows: Job[] = [
      { id: 'destroy-retry-second-before', label: 'target', status: 'queued' },
      { id: 'destroy-retry-second-target', label: 'target', status: 'queued' },
      { id: 'destroy-retry-second-after', label: 'target', status: 'done' }
    ];
    const secondFailureId = 'destroy-retry-second-target';
    JobModel.byLabel({ label: 'target' }).seed(secondFailureRows);
    const secondFailureBefore = workSnapshot(storage, affected, unrelated);
    await act(async () => {
      await expect(JobModel.actions.change.run({ id: secondFailureId })).rejects.toThrow('destroy attempt 3 failed');
    });

    expect(JobModel.find(secondFailureId)).toEqual(secondFailureRows[1]);
    expect(JobModel.byLabel({ label: 'target' }).read()).toEqual(secondFailureRows);
    expect(JobModel.operation(secondFailureId).read()).toMatchObject({ pending: false, failed: true });
    expectWork(storage, affected, unrelated, secondFailureBefore, { wal: 2, commits: 2, affectedTicks: 1 });

    const failedOperation = getOperationState().open().find(operation => operation.status === 'failed');
    expect(failedOperation).toBeDefined();
    const discardBefore = workSnapshot(storage, affected, unrelated);
    act(() => {
      JobModel.actions.change.discard(secondFailureId);
    });

    expect(JobModel.find(secondFailureId)).toEqual(secondFailureRows[1]);
    expect(JobModel.byLabel({ label: 'target' }).read()).toEqual(secondFailureRows);
    expect(getOperationState().get(failedOperation!.operationId)).toBeUndefined();
    expect(getOperationState().open()).toEqual([]);
    expectWork(storage, affected, unrelated, discardBefore, { wal: 1, commits: 1, affectedTicks: 0 });

    const callsAfterDiscard = transport.calls.length;
    await expect(JobModel.actions.change.retry(secondFailureId)).resolves.toBeNull();
    expect(transport.calls).toHaveLength(callsAfterDiscard);
    expect(JobModel.operation(secondFailureId).read()).toEqual({ pending: false, failed: false, unsyncedChanges: undefined });
    affected.unmount();
    unrelated.unmount();
  });

  it('rejects an empty poll key before transport and root planning', async () => {
    const storage = createMemoryPlane();
    const transport = createMockTransport();
    configureDb({ storage, transport });
    const Unrelated = defineUnrelated('SpecActionModePollKeyUnrelated');
    let rootCalls = 0;
    const JobModel = defineModel('SpecActionModePollKey', {
      schema: JobSchema,
      actions: owner => ({
        status: owner.gql.action(statusDocument, {
          mode: 'poll',
          variables: (input: StatusInput) => input,
          root: {
            update: {
              select: () => {
                rootCalls += 1;
                return null;
              }
            }
          },
          poll: { key: () => '', intervalMs: 10, maxAttempts: 2 }
        })
      })
    });
    JobModel.insert({ id: 'poll-empty', label: 'poll', status: 'queued' });
    const affected = renderCounted(() => JobModel.useFind('poll-empty'));
    const unrelated = renderCounted(() => Unrelated.useFind(unrelatedRow.id));
    const before = workSnapshot(storage, affected, unrelated);

    await expect(JobModel.actions.status.run({ id: 'poll-empty' })).rejects.toThrow('Poll action key must be a non-empty string');

    expect(transport.calls).toHaveLength(0);
    expect(rootCalls).toBe(0);
    expectWork(storage, affected, unrelated, before, { wal: 0, commits: 0, affectedTicks: 0 });
    affected.unmount();
    unrelated.unmount();
  });

  it('runs one poll request and commits its accepted payload once', async () => {
    const storage = createMemoryPlane();
    const transport = createMockTransport({
      query: async <TData,>(operation: Parameters<DbTransport['query']>[0]) => {
        expect(operation.query).toBe(statusDocument);
        expect(operation.variables).toEqual({ id: 'poll-once' });
        return { data: { jobStatus: { id: 'poll-once', status: 'done' } } as TData };
      }
    });
    configureDb({ storage, transport });
    const Unrelated = defineUnrelated('SpecActionModePollRunUnrelated');
    const JobModel = defineModel('SpecActionModePollRun', {
      schema: JobSchema,
      actions: owner => ({
        status: owner.gql.action(statusDocument, {
          mode: 'poll',
          variables: (input: StatusInput) => input,
          root: {
            update: {
              select: data => ({
                id: data.jobStatus.id,
                patch: { status: data.jobStatus.status }
              })
            }
          },
          poll: { key: (input: StatusInput) => input.id, intervalMs: 10, maxAttempts: 2 }
        })
      })
    });
    JobModel.insert({ id: 'poll-once', label: 'poll', status: 'queued' });
    const affected = renderCounted(() => JobModel.useFind('poll-once'));
    const unrelated = renderCounted(() => Unrelated.useFind(unrelatedRow.id));
    const before = workSnapshot(storage, affected, unrelated);

    await act(async () => {
      await JobModel.actions.status.run({ id: 'poll-once' });
    });

    expect(transport.calls).toHaveLength(1);
    expect(JobModel.find('poll-once')).toEqual({ id: 'poll-once', label: 'poll', status: 'done' });
    expectWork(storage, affected, unrelated, before, { wal: 1, commits: 1, affectedTicks: 1 });
    affected.unmount();
    unrelated.unmount();
  });

  it('owns poll phase, attempts, refresh and terminal teardown', async () => {
    jest.useFakeTimers();
    const order: string[] = [];
    let response = 0;
    const storage = createMemoryPlane();
    const transport = createMockTransport({
      query: async <TData,>() => {
        order.push('transport');
        response += 1;
        return {
          data: { jobStatus: { id: 'poll-job', status: response === 1 ? 'pending' : 'done' } } as TData
        };
      }
    });
    configureDb({ storage, transport });
    const Unrelated = defineUnrelated('SpecActionModePollUnrelated');
    const JobModel = defineModel('SpecActionModePoll', {
      schema: JobSchema,
      actions: owner => ({
        status: owner.gql.action(statusDocument, {
          mode: 'poll',
          variables: (input: StatusInput) => {
            order.push('variables');
            return input;
          },
          root: {
            update: {
              select: data => ({ id: data.jobStatus.id, patch: { status: data.jobStatus.status } })
            }
          },
          poll: {
            key: (input: StatusInput) => {
              order.push('key');
              return input.id;
            },
            intervalMs: 10,
            maxAttempts: 3,
            classify: (data: StatusData) => (data.jobStatus.status === 'done' ? 'ready' : null)
          }
        })
      })
    });
    JobModel.insert({ id: 'poll-job', label: 'poll', status: 'queued' });
    const affected = renderCounted(() => JobModel.useFind('poll-job'));
    const unrelated = renderCounted(() => Unrelated.useFind(unrelatedRow.id));
    const phase = renderCounted(() => JobModel.actions.status.use({ id: 'poll-job' }));
    const sibling = renderCounted(() => JobModel.actions.status.use({ id: 'poll-job' }));
    const before = workSnapshot(storage, affected, unrelated);

    await settle();

    expect(order.slice(0, 3)).toEqual(['key', 'variables', 'transport']);
    expect(phase.result()).toMatchObject({ phase: 'polling', attempts: 1 });
    expect(JobModel.find('poll-job')?.status).toBe('pending');
    expectWork(storage, affected, unrelated, before, { wal: 1, commits: 1, affectedTicks: 1 });

    const refreshBefore = workSnapshot(storage, affected, unrelated);
    await act(async () => phase.result().refresh());

    expect(phase.result()).toEqual({ phase: 'ready', reason: 'terminal-payload', attempts: 2, refresh: phase.result().refresh });
    expect(sibling.result().phase).toBe('ready');
    expect(JobModel.find('poll-job')?.status).toBe('done');
    expectWork(storage, affected, unrelated, refreshBefore, { wal: 1, commits: 1, affectedTicks: 1 });

    act(() => jest.advanceTimersByTime(100));
    await settle();
    expect(transport.calls).toHaveLength(2);
    phase.unmount();
    sibling.unmount();
    affected.unmount();
    unrelated.unmount();
  });

  it('drops a pending poll landing after reset and stops its interval', async () => {
    jest.useFakeTimers();
    let resolveStatus!: (value: { data: StatusData }) => void;
    const response = new Promise<{ data: StatusData }>(resolve => {
      resolveStatus = resolve;
    });
    const storage = createMemoryPlane();
    const transport = createMockTransport({
      query: async <TData,>() => {
        const result = await response;
        return { data: result.data as TData };
      }
    });
    configureDb({ storage, transport });
    const JobModel = defineModel('SpecActionModePollReset', {
      schema: JobSchema,
      actions: owner => ({
        status: owner.gql.action(statusDocument, {
          mode: 'poll',
          variables: (input: StatusInput) => input,
          root: { update: { select: data => ({ id: data.jobStatus.id, patch: { status: data.jobStatus.status } }) } },
          poll: { key: (input: StatusInput) => input.id, intervalMs: 10, maxAttempts: 3 }
        })
      })
    });
    const affected = renderCounted(() => JobModel.useFind('poll-reset'));
    const phase = renderCounted(() => JobModel.actions.status.use({ id: 'poll-reset' }));
    await settle();
    expect(transport.calls).toHaveLength(1);
    const before = {
      wal: storage.keys('dbl:journal:').length,
      commits: diagnostics().snapshot().commits,
      affectedTicks: affected.renders()
    };

    act(() => resetRuntime());
    await act(async () => {
      resolveStatus({ data: { jobStatus: { id: 'poll-reset', status: 'done' } } });
      await response;
    });
    act(() => jest.advanceTimersByTime(100));
    await settle();

    expect(JobModel.find('poll-reset')).toBeUndefined();
    expect(storage.keys('dbl:journal:').length - before.wal).toBe(0);
    expect(diagnostics().snapshot().commits - before.commits).toBe(0);
    expect(affected.renders() - before.affectedTicks).toBe(0);
    expect(transport.calls).toHaveLength(1);
    expect(phase.result()).toMatchObject({ phase: 'idle', attempts: 0 });
    phase.unmount();
    affected.unmount();
  });
});
