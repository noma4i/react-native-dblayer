import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { act } from 'react';
import { bootDb, configureDb, defineModel, defineShape, f, getOperationState, MutationDeliveryUnknownError, suspendDb } from '../../testApi';
import type { DbTransport } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics, renderCounted, settle } from '../helpers/harness';

type Job = {
  id: string;
  label: string;
  status: 'pending' | 'done';
};

type Audit = {
  id: string;
  jobId: string;
  label: string;
};

type StartInput = { label: string };
type TransportInput = { token: string };
type StartData = { startJob: { job: Job; audit: Audit } };
type StartVariables = { input: { label: string; token: string } };
type MemoryPlane = ReturnType<typeof createMemoryPlane>;
type Reader = { renders(): number; unmount(): void };

const JobSchema = defineShape<Job>()({
  label: f.str(),
  status: f.enum(['pending', 'done'] as const)
});
const AuditSchema = defineShape<Audit>()({ jobId: f.str(), label: f.str() });
const startDocument: TypedDocumentNode<StartData, StartVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const unrelatedRow: Job = { id: 'unrelated', label: 'unrelated', status: 'done' };

const workSnapshot = (storage: MemoryPlane, owner: Reader, audit: Reader, unrelated: Reader) => ({
  wal: storage.keys('dbl:journal:').length,
  commits: diagnostics().snapshot().commits,
  ownerTicks: owner.renders(),
  auditTicks: audit.renders(),
  unrelatedTicks: unrelated.renders()
});

const expectWork = (
  storage: MemoryPlane,
  readers: { owner: Reader; audit: Reader; unrelated: Reader },
  before: ReturnType<typeof workSnapshot>,
  expected: { wal: number; commits: number; ownerTicks: number; auditTicks: number }
): void => {
  expect(storage.keys('dbl:journal:').length - before.wal).toBe(expected.wal);
  expect(diagnostics().snapshot().commits - before.commits).toBe(expected.commits);
  expect(readers.owner.renders() - before.ownerTicks).toBe(expected.ownerTicks);
  expect(readers.audit.renders() - before.auditTicks).toBe(expected.auditTicks);
  expect(readers.unrelated.renders() - before.unrelatedTicks).toBe(0);
};

const defineFixture = async (storage: MemoryPlane, transport: DbTransport, key: string, options: { seedUnrelated?: boolean } = {}) => {
  configureDb({ storage, transport });
  const AuditModel = defineModel(`${key}Audit`, { schema: AuditSchema });
  const Unrelated = defineModel(`${key}Unrelated`, { schema: JobSchema });
  const JobModel = defineModel(key, {
    schema: JobSchema,
    maintenance: { dropTempRowsAfterMs: 60_000 },
    actions: owner => ({
      start: owner.gql.action(startDocument, {
        mode: 'durable',
        result: 'startJob',
        variables: (input: StartInput, transportInput: TransportInput) => ({
          input: { label: input.label, token: transportInput.token }
        }),
        optimistic: {
          root: {
            insert: {
              select: ({ input, tempId }) => ({
                id: tempId,
                label: input.label,
                status: 'pending' as const
              })
            }
          }
        },
        root: {
          insert: { select: ({ data }) => data.startJob.job }
        },
        write: ({ data }, plan) => {
          plan.upsert(AuditModel, data.startJob.audit);
        }
      })
    })
  });
  await bootDb();
  if (options.seedUnrelated ?? true) Unrelated.insert(unrelatedRow);
  return { JobModel, AuditModel, Unrelated };
};

const mountReaders = ({ JobModel, AuditModel, Unrelated }: Awaited<ReturnType<typeof defineFixture>>) => ({
  owner: renderCounted(() => JobModel.where({}).use().data),
  audit: renderCounted(() => AuditModel.where({}).use().data),
  unrelated: renderCounted(() => Unrelated.useFind(unrelatedRow.id))
});

const unmountReaders = (readers: ReturnType<typeof mountReaders>): void => {
  readers.owner.unmount();
  readers.audit.unmount();
  readers.unrelated.unmount();
};

describe('durable action transport', () => {
  it('starts atomically without transport and exposes only the typed handle', async () => {
    const storage = createMemoryPlane();
    const transport = createMockTransport();
    const { JobModel, AuditModel, Unrelated } = await defineFixture(storage, transport, 'SpecDurableStart');
    const readers = mountReaders({ JobModel, AuditModel, Unrelated });
    const before = workSnapshot(storage, readers.owner, readers.audit, readers.unrelated);

    let handle!: ReturnType<typeof JobModel.actions.start.start>;
    act(() => {
      handle = JobModel.actions.start.start({ label: 'created' });
    });

    expect(Object.keys(handle).sort()).toEqual(['cancel', 'execute', 'operationId', 'tempId']);
    expect(transport.calls).toHaveLength(0);
    expect(JobModel.find(handle.tempId)).toEqual({ id: handle.tempId, label: 'created', status: 'pending' });
    expect(JobModel.operation(handle.tempId).read()).toMatchObject({ pending: true, failed: false });
    expect(getOperationState().pending()[0]).toMatchObject({ operationId: handle.operationId, tempIds: [handle.tempId] });
    expectWork(storage, readers, before, { wal: 1, commits: 1, ownerTicks: 1, auditTicks: 0 });
    unmountReaders(readers);
  });

  it('executes the exact document and variables and commits all response writes once', async () => {
    const storage = createMemoryPlane();
    let capturedOperation: Parameters<DbTransport['mutation']>[0] | undefined;
    const transport = createMockTransport({
      mutation: async <TData,>(operation: Parameters<DbTransport['mutation']>[0]) => {
        capturedOperation = operation;
        return {
          data: {
            startJob: {
              job: { id: 'server-job', label: 'created', status: 'done' },
              audit: { id: 'audit-1', jobId: 'server-job', label: 'created' }
            }
          } as TData
        };
      }
    });
    const { JobModel, AuditModel, Unrelated } = await defineFixture(storage, transport, 'SpecDurableSuccess');
    const handle = JobModel.actions.start.start({ label: 'created' });
    const readers = mountReaders({ JobModel, AuditModel, Unrelated });
    const before = workSnapshot(storage, readers.owner, readers.audit, readers.unrelated);

    let result: StartData['startJob'] | null = null;
    await act(async () => {
      result = await handle.execute({ token: 'token-1' });
    });

    expect(capturedOperation).toEqual({
      mutation: startDocument,
      variables: { input: { label: 'created', token: 'token-1' } }
    });
    expect(JobModel.find(handle.tempId)).toBeUndefined();
    expect(JobModel.find('server-job')).toEqual({ id: 'server-job', label: 'created', status: 'done' });
    expect(AuditModel.find('audit-1')).toEqual({ id: 'audit-1', jobId: 'server-job', label: 'created' });
    expect(result).toEqual({
      job: { id: 'server-job', label: 'created', status: 'done' },
      audit: { id: 'audit-1', jobId: 'server-job', label: 'created' }
    });
    expect(JobModel.operation(handle.tempId).read()).toEqual({
      pending: false,
      failed: false,
      deliveryUnknown: false,
      unsyncedChanges: undefined
    });
    expectWork(storage, readers, before, { wal: 1, commits: 1, ownerTicks: 1, auditTicks: 1 });
    unmountReaders(readers);
  });

  it('coalesces concurrent execute calls for one pending handle', async () => {
    let resolveResponse!: (value: { data: StartData }) => void;
    const response = new Promise<{ data: StartData }>(resolve => {
      resolveResponse = resolve;
    });
    const storage = createMemoryPlane();
    const transport = createMockTransport({
      mutation: async <TData,>() => {
        const result = await response;
        return { data: result.data as TData };
      }
    });
    const { JobModel, AuditModel, Unrelated } = await defineFixture(storage, transport, 'SpecDurableSingleFlight');
    const handle = JobModel.actions.start.start({ label: 'single-flight' });
    const readers = mountReaders({ JobModel, AuditModel, Unrelated });
    const before = workSnapshot(storage, readers.owner, readers.audit, readers.unrelated);
    let first!: Promise<StartData['startJob'] | null>;
    let second!: Promise<StartData['startJob'] | null>;

    act(() => {
      first = handle.execute({ token: 'shared-token' });
      second = handle.execute({ token: 'shared-token' });
    });
    await settle();

    expect(transport.calls).toHaveLength(1);
    let results!: [StartData['startJob'] | null, StartData['startJob'] | null];
    await act(async () => {
      resolveResponse({
        data: {
          startJob: {
            job: { id: 'single-server', label: 'single-flight', status: 'done' },
            audit: { id: 'single-audit', jobId: 'single-server', label: 'single-flight' }
          }
        }
      });
      results = await Promise.all([first, second]);
    });

    expect(results[0]).toEqual(results[1]);
    expect(JobModel.find(handle.tempId)).toBeUndefined();
    expect(JobModel.where({}).read()).toEqual([{ id: 'single-server', label: 'single-flight', status: 'done' }]);
    expect(AuditModel.where({}).read()).toEqual([{ id: 'single-audit', jobId: 'single-server', label: 'single-flight' }]);
    expectWork(storage, readers, before, { wal: 1, commits: 1, ownerTicks: 1, auditTicks: 1 });
    unmountReaders(readers);
  });

  it('keeps failure open and re-executes the same operation and optimistic row', async () => {
    let attempt = 0;
    let resolveRetry!: (value: { data: StartData }) => void;
    const retryResponse = new Promise<{ data: StartData }>(resolve => {
      resolveRetry = resolve;
    });
    const storage = createMemoryPlane();
    const transport = createMockTransport({
      mutation: async <TData,>() => {
        attempt += 1;
        if (attempt === 1) throw new Error('transport failed');
        const response = await retryResponse;
        return { data: response.data as TData };
      }
    });
    const { JobModel, AuditModel, Unrelated } = await defineFixture(storage, transport, 'SpecDurableRetry');
    const handle = JobModel.actions.start.start({ label: 'retry' });
    const readers = mountReaders({ JobModel, AuditModel, Unrelated });
    const failedBefore = workSnapshot(storage, readers.owner, readers.audit, readers.unrelated);

    await act(async () => {
      await expect(handle.execute({ token: 'failed-token' })).rejects.toThrow('transport failed');
    });

    expect(JobModel.find(handle.tempId)).toEqual({ id: handle.tempId, label: 'retry', status: 'pending' });
    expect(JobModel.operation(handle.tempId).read()).toMatchObject({ pending: false, failed: true });
    expectWork(storage, readers, failedBefore, { wal: 1, commits: 1, ownerTicks: 0, auditTicks: 0 });

    const resumed = JobModel.actions.start.resume(handle.operationId);
    expect(resumed).toBeDefined();
    expect(resumed).toMatchObject({ operationId: handle.operationId, tempId: handle.tempId });
    const retryBefore = workSnapshot(storage, readers.owner, readers.audit, readers.unrelated);
    let retry!: Promise<StartData['startJob'] | null>;
    act(() => {
      retry = resumed!.execute({ token: 'retry-token' });
    });
    await settle();
    expect(getOperationState().get(handle.operationId)?.status).toBe('pending');
    expect(getOperationState().pending()[0]).toMatchObject({ operationId: handle.operationId, tempIds: [handle.tempId] });
    expect(JobModel.where({}).read()).toEqual([{ id: handle.tempId, label: 'retry', status: 'pending' }]);

    await act(async () => {
      resolveRetry({
        data: {
          startJob: {
            job: { id: 'retry-server', label: 'retry', status: 'done' },
            audit: { id: 'audit-retry', jobId: 'retry-server', label: 'retry' }
          }
        }
      });
      await retry;
    });

    expect(transport.calls).toHaveLength(2);
    expect(JobModel.find(handle.tempId)).toBeUndefined();
    expect(JobModel.find('retry-server')).toEqual({ id: 'retry-server', label: 'retry', status: 'done' });
    expectWork(storage, readers, retryBefore, { wal: 2, commits: 2, ownerTicks: 1, auditTicks: 1 });
    unmountReaders(readers);
  });

  it('keeps unknown delivery open but blocks automatic re-execution', async () => {
    const storage = createMemoryPlane();
    const transport = createMockTransport({
      mutation: async () => {
        throw new MutationDeliveryUnknownError('mutation response was not observed');
      }
    });
    const { JobModel } = await defineFixture(storage, transport, 'SpecDurableDeliveryUnknown');
    const handle = JobModel.actions.start.start({ label: 'unknown' });

    await expect(handle.execute({ token: 'token-1' })).rejects.toThrow('mutation response was not observed');

    expect(JobModel.find(handle.tempId)).toEqual({ id: handle.tempId, label: 'unknown', status: 'pending' });
    expect(JobModel.operation(handle.tempId).read()).toMatchObject({
      pending: false,
      failed: false,
      deliveryUnknown: true
    });
    expect(JobModel.actions.start.open()).toHaveLength(1);
    await expect(handle.execute({ token: 'token-2' })).resolves.toBeNull();
    expect(transport.calls).toHaveLength(1);
  });

  it('cancels and rolls back the optimistic row in one envelope', async () => {
    const storage = createMemoryPlane();
    const transport = createMockTransport();
    const { JobModel, AuditModel, Unrelated } = await defineFixture(storage, transport, 'SpecDurableCancel');
    const handle = JobModel.actions.start.start({ label: 'cancel' });
    const readers = mountReaders({ JobModel, AuditModel, Unrelated });
    const before = workSnapshot(storage, readers.owner, readers.audit, readers.unrelated);

    act(() => handle.cancel());

    expect(JobModel.find(handle.tempId)).toBeUndefined();
    expect(JobModel.operation(handle.tempId).read()).toEqual({
      pending: false,
      failed: false,
      deliveryUnknown: false,
      unsyncedChanges: undefined
    });
    expectWork(storage, readers, before, { wal: 1, commits: 1, ownerTicks: 1, auditTicks: 0 });
    expect(transport.calls).toHaveLength(0);
    unmountReaders(readers);
  });

  it('does not resume an operation through another action on the same model', () => {
    const storage = createMemoryPlane();
    const transport = createMockTransport();
    configureDb({ storage, transport });
    const AuditModel = defineModel('SpecDurableOwnershipAudit', { schema: AuditSchema });
    const Unrelated = defineModel('SpecDurableOwnershipUnrelated', { schema: JobSchema });
    Unrelated.insert(unrelatedRow);
    const JobModel = defineModel('SpecDurableOwnership', {
      schema: JobSchema,
      maintenance: { dropTempRowsAfterMs: 60_000 },
      actions: owner => ({
        first: owner.gql.action(startDocument, {
          mode: 'durable',
          result: 'startJob',
          variables: (input: StartInput, transportInput: TransportInput) => ({
            input: { label: input.label, token: transportInput.token }
          }),
          optimistic: {
            root: {
              insert: {
                select: ({ input, tempId }) => ({ id: tempId, label: input.label, status: 'pending' as const })
              }
            }
          },
          root: { insert: { select: ({ data }) => data.startJob.job } },
          write: ({ data }, plan) => {
            plan.upsert(AuditModel, data.startJob.audit);
          }
        }),
        second: owner.gql.action(startDocument, {
          mode: 'durable',
          result: 'startJob',
          variables: (input: StartInput, transportInput: TransportInput) => ({
            input: { label: input.label, token: transportInput.token }
          }),
          optimistic: {
            root: {
              insert: {
                select: ({ input, tempId }) => ({ id: tempId, label: input.label, status: 'pending' as const })
              }
            }
          },
          root: { insert: { select: ({ data }) => data.startJob.job } },
          write: ({ data }, plan) => {
            plan.upsert(AuditModel, data.startJob.audit);
          }
        })
      })
    });
    const handle = JobModel.actions.first.start({ label: 'owned' });
    const secondHandle = JobModel.actions.first.start({ label: 'owned-second' });
    const readers = {
      owner: renderCounted(() => JobModel.where({}).use().data),
      audit: renderCounted(() => AuditModel.where({}).use().data),
      unrelated: renderCounted(() => Unrelated.useFind(unrelatedRow.id))
    };
    const before = workSnapshot(storage, readers.owner, readers.audit, readers.unrelated);

    const wrongOwner = JobModel.actions.second.resume(handle.operationId);
    const ownedOperations = JobModel.actions.first.open();

    expect(wrongOwner).toBeUndefined();
    expect(JobModel.actions.second.open()).toEqual([]);
    expect(ownedOperations.map(operation => operation.input)).toEqual([{ label: 'owned' }, { label: 'owned-second' }]);
    expect(ownedOperations[0]?.handle).toMatchObject({ operationId: handle.operationId, tempId: handle.tempId });
    expect(ownedOperations[1]?.handle).toMatchObject({ operationId: secondHandle.operationId, tempId: secondHandle.tempId });
    expect(JobModel.actions.first.resume(handle.operationId)).toMatchObject({
      operationId: handle.operationId,
      tempId: handle.tempId
    });
    expectWork(storage, readers, before, { wal: 0, commits: 0, ownerTicks: 0, auditTicks: 0 });
    expect(transport.calls).toHaveLength(0);
    unmountReaders(readers);
  });

  it('resumes and executes the same typed handle after runtime reconfiguration', async () => {
    const storage = createMemoryPlane();
    const firstTransport = createMockTransport();
    const first = await defineFixture(storage, firstTransport, 'SpecDurableRestart');
    const handle = first.JobModel.actions.start.start({ label: 'restart' });
    suspendDb();
    let capturedOperation: Parameters<DbTransport['mutation']>[0] | undefined;
    const secondTransport = createMockTransport({
      mutation: async <TData,>(operation: Parameters<DbTransport['mutation']>[0]) => {
        capturedOperation = operation;
        return {
          data: {
            startJob: {
              job: { id: 'restart-server', label: 'restart', status: 'done' },
              audit: { id: 'restart-audit', jobId: 'restart-server', label: 'restart' }
            }
          } as TData
        };
      }
    });
    const second = await defineFixture(storage, secondTransport, 'SpecDurableRestart', { seedUnrelated: false });

    expect(second.Unrelated.find(unrelatedRow.id)).toEqual(unrelatedRow);
    expect(second.JobModel.find(handle.tempId)).toEqual({ id: handle.tempId, label: 'restart', status: 'pending' });
    expect(getOperationState().open()).toEqual(
      expect.arrayContaining([expect.objectContaining({ operationId: handle.operationId, tempIds: [handle.tempId] })])
    );
    const restored = second.JobModel.actions.start.open();
    const resumed = restored[0]?.handle;

    expect(restored.map(operation => operation.input)).toEqual([{ label: 'restart' }]);
    expect(resumed).toBeDefined();
    expect(Object.keys(resumed!).sort()).toEqual(['cancel', 'execute', 'operationId', 'tempId']);
    expect(resumed).toMatchObject({ operationId: handle.operationId, tempId: handle.tempId });
    const readers = mountReaders(second);
    const before = workSnapshot(storage, readers.owner, readers.audit, readers.unrelated);

    await act(async () => {
      await resumed!.execute({ token: 'restart-token' });
    });

    expect(capturedOperation).toEqual({
      mutation: startDocument,
      variables: { input: { label: 'restart', token: 'restart-token' } }
    });
    expect(second.JobModel.find(handle.tempId)).toBeUndefined();
    expect(second.JobModel.where({}).read()).toEqual([{ id: 'restart-server', label: 'restart', status: 'done' }]);
    expect(second.AuditModel.where({}).read()).toEqual([{ id: 'restart-audit', jobId: 'restart-server', label: 'restart' }]);
    expect(getOperationState().open()).toEqual([]);
    expectWork(storage, readers, before, { wal: 1, commits: 1, ownerTicks: 1, auditTicks: 1 });
    expect(firstTransport.calls).toHaveLength(0);
    expect(secondTransport.calls).toHaveLength(1);
    unmountReaders(readers);
  });
});
