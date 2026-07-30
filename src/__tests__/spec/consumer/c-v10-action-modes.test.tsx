import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { act } from 'react';
import { configureDb, defineModel, defineShape, f, gql } from '../../../index';
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
  jobStatus: JobInput;
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

describe('v10 action modes', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts and completes a durable action through one model-owned handle', () => {
    const transport = createMockTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const Job = defineModel('SpecV10DurableJob', {
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

  it('owns a refcounted poll lifecycle and lands each status response', async () => {
    jest.useFakeTimers();
    const transport = createMockTransport({
      query: async <TData,>() => ({
        data: {
          jobStatus: {
            id: 'job-1',
            label: 'render',
            status: 'done'
          }
        } as TData
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const Job = defineModel('SpecV10PollJob', {
      schema: JobSchema,
      actions: {
        status: gql.action(statusDocument, {
          result: 'jobStatus',
          variables: input => input,
          kind: 'update',
          mode: 'poll',
          id: input => input.id,
          select: data => data.jobStatus,
          poll: {
            intervalMs: 10,
            maxAttempts: 3,
            classify: data => (data.jobStatus.status === 'done' ? 'ready' : null)
          }
        })
      }
    });
    Job.insert({ id: 'job-1', label: 'render', status: 'pending' });

    const reader = renderCounted(() => Job.actions.status.use({ id: 'job-1' }));
    await settle();

    expect(reader.result().phase).toBe('ready');
    expect(Job.find('job-1')?.status).toBe('done');
    expect(transport.calls).toHaveLength(1);

    act(() => {
      jest.advanceTimersByTime(100);
    });
    await settle();
    expect(transport.calls).toHaveLength(1);
    reader.unmount();
  });
});
