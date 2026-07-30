import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { act } from 'react';
import { configureDb, defineModel, defineShape, f, gql } from '../../../index';
import type { DbTransport } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted, settle } from '../helpers/harness';

type JobInput = {
  id: string;
  label: string;
  status: 'pending' | 'done';
};

type StartData = {
  startJob: {
    job: JobInput;
  };
};

type StartVariables = {
  input: {
    label: string;
  };
};

type StatusData = {
  jobStatus: Pick<JobInput, 'status'>;
};

type StatusVariables = {
  id: string;
};

const startDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<StartData, StartVariables>;
const statusDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<StatusData, StatusVariables>;

const JobSchema = defineShape<JobInput>()({
  label: f.str(),
  status: f.enum(['pending', 'done'] as const)
});

describe('action modes', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs request lifecycle callbacks around commit and rollback', async () => {
    const calls: string[] = [];
    const transport = createMockTransport({
      mutation: async <TData,>(operation: Parameters<DbTransport['mutation']>[0]) => {
        const variables = operation.variables as StartVariables;
        expect(variables).toEqual({ input: { label: expect.any(String) } });
        const input = variables.input;
        if (input.label === 'fail') throw new Error('rejected');
        return {
          data: {
            startJob: {
              job: { id: 'job-1', label: input.label, status: 'done' }
            }
          } as TData
        };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const Job = defineModel('SpecRequestLifecycleJob', {
      schema: JobSchema,
      actions: {
        start: gql.action(startDocument, {
          result: 'startJob',
          variables: input => ({ input }),
          kind: 'insert',
          select: data => data.startJob.job,
          before: input => calls.push(`before:${input.label}`),
          after: ({ input, data }) => calls.push(`after:${input.label}:${data.startJob.job.id}`),
          error: (error, { input }) => calls.push(`error:${input.label}:${error.message}`)
        })
      }
    });

    await Job.actions.start.run({ label: 'pass' });
    await expect(Job.actions.start.run({ label: 'fail' })).rejects.toThrow('rejected');

    expect(calls).toEqual(['before:pass', 'after:pass:job-1', 'before:fail', 'error:fail:rejected']);
  });

  it('starts and completes a durable action through one model-owned handle', () => {
    const transport = createMockTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const Job = defineModel('SpecDurableJob', {
      schema: JobSchema,
      actions: {
        start: gql.action(startDocument, {
          result: 'startJob',
          variables: input => ({ input }),
          kind: 'insert',
          mode: 'durable',
          select: data => data.startJob.job,
          optimistic: {
            build: (input, context) => ({
              id: context.tempId,
              label: input.label,
              status: 'pending'
            }),
            failure: 'keep'
          },
          resume: async () => 'continue'
        })
      },
      maintenance: { dropTempRowsAfterMs: 1000 }
    });

    const entry = Job.actions.start.run({ label: 'render' });

    expect(transport.calls).toEqual([]);
    expect(Job.find(entry.tempId)).toEqual({
      id: entry.tempId,
      label: 'render',
      status: 'pending'
    });
    expect(Job.operation(entry.tempId).read().pending).toBe(true);

    Job.actions.start.complete(entry.operationId, {
      id: 'job-1',
      label: 'render',
      status: 'done'
    });

    expect(Job.find(entry.tempId)).toBeUndefined();
    expect(Job.find('job-1')).toEqual({
      id: 'job-1',
      label: 'render',
      status: 'done'
    });
    expect(Job.operation('job-1').read().pending).toBe(false);
  });

  it('fails, resumes, and discards durable work through one handle', async () => {
    const transport = createMockTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const Job = defineModel('SpecDurableLifecycleJob', {
      schema: JobSchema,
      actions: {
        start: gql.action(startDocument, {
          result: 'startJob',
          variables: input => ({ input }),
          kind: 'insert',
          mode: 'durable',
          select: data => data.startJob.job,
          optimistic: {
            build: (input, context) => ({
              id: context.tempId,
              label: input.label,
              status: 'pending'
            }),
            failure: 'keep',
            onFailurePatch: () => ({ status: 'pending' })
          },
          resume: async entry => (entry.input.label === 'orphan' ? 'orphaned' : 'continue')
        })
      },
      maintenance: { dropTempRowsAfterMs: 1000 }
    });

    const continued = Job.actions.start.run({ label: 'continue' });
    Job.actions.start.fail(continued.operationId, new Error('failed'));
    expect(Job.operation(continued.tempId).read().failed).toBe(true);
    await expect(Job.actions.start.retry(continued.operationId)).resolves.toBe('continue');
    Job.actions.start.discard(continued.operationId);
    expect(Job.find(continued.tempId)).toBeUndefined();

    const orphaned = Job.actions.start.run({ label: 'orphan' });
    Job.actions.start.fail(orphaned.operationId, new Error('failed'));
    await expect(Job.actions.start.retry(orphaned.operationId)).resolves.toBe('orphaned');
    Job.actions.start.discard(orphaned.operationId);
  });

  it('rejects a durable insert without an optimistic row', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    expect(() =>
      defineModel('SpecInvalidDurableJob', {
        schema: JobSchema,
        actions: {
          start: gql.action(startDocument, {
            result: 'startJob',
            variables: input => ({ input }),
            kind: 'insert',
            mode: 'durable',
            select: data => data.startJob.job,
            resume: async () => 'continue'
          })
        }
      })
    ).toThrow('durable insert requires optimistic build');
  });

  it('owns a refcounted poll lifecycle and lands each status response', async () => {
    jest.useFakeTimers();
    const transport = createMockTransport({
      query: async <TData,>() => ({
        data: {
          jobStatus: {
            status: 'done'
          }
        } as TData
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const Job = defineModel('SpecPollJob', {
      schema: JobSchema,
      actions: {
        status: gql.action(statusDocument, {
          result: 'jobStatus',
          variables: input => input,
          kind: 'update',
          mode: 'poll',
          id: input => input.id,
          select: data => ({ status: data.jobStatus.status }),
          poll: {
            intervalMs: 10,
            maxAttempts: 3,
            classify: data => (data.jobStatus.status === 'done' ? 'ready' : null)
          }
        })
      }
    });
    Job.insert({ id: 'job-1', label: 'render', status: 'pending' });

    const inactive = renderCounted(() => Job.actions.status.use(null));
    expect(inactive.result()).toMatchObject({ phase: 'idle', attempts: 0 });
    expect(transport.calls).toHaveLength(0);
    await inactive.result().refresh();
    inactive.unmount();

    const reader = renderCounted(() => Job.actions.status.use({ id: 'job-1' }));
    const sibling = renderCounted(() => Job.actions.status.use({ id: 'job-1' }));
    await settle();

    expect(reader.result().phase).toBe('ready');
    expect(Job.find('job-1')).toEqual({ id: 'job-1', label: 'render', status: 'done' });
    expect(transport.calls).toHaveLength(1);
    await act(async () => {
      await reader.result().refresh();
    });
    expect(transport.calls).toHaveLength(2);
    Job.insert({ id: 'job-2', label: 'second', status: 'pending' });
    await Job.actions.status.run({ id: 'job-2' });
    expect(transport.calls).toHaveLength(3);

    act(() => {
      jest.advanceTimersByTime(100);
    });
    await settle();
    expect(transport.calls).toHaveLength(3);
    reader.unmount();
    sibling.unmount();
  });

  it('rejects a poll action without a readable id', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const Job = defineModel('SpecPollMissingIdJob', {
      schema: JobSchema,
      actions: {
        status: gql.action(statusDocument, {
          result: 'jobStatus',
          variables: input => input,
          kind: 'update',
          mode: 'poll',
          id: () => undefined as never,
          select: data => ({ status: data.jobStatus.status }),
          poll: {
            intervalMs: 10,
            maxAttempts: 1
          }
        })
      }
    });

    await expect(Job.actions.status.run({ id: 'missing' })).rejects.toThrow('action requires id');
  });
});
