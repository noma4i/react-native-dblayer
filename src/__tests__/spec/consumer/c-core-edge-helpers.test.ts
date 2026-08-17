import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { act } from 'react';
import { configureDb, createCommitEnvelope, defineModel, defineModelRuntime, defineShape, f, getApplyRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted, renderCountedInProvider, settle } from '../helpers/harness';

type ObjectValue = Record<string, unknown>;

describe('snapshot landing equality', () => {
  it('drops an explicitly-removed field in one wave and swallows a reference-only rewrite of a serialized field', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineModelRuntime({
      id: 'SpecCoreEdgeDiff',
      name: 'SpecCoreEdgeDiff',
      fields: { kept: f.str(), removed: f.str().optional(), value: f.raw<ObjectValue>() }
    });
    rows.insert({ id: 'row-1', kept: 'kept', removed: 'remove-me', value: { count: 1 } });
    const reader = renderCounted(() => rows.use.find('row-1'));
    const before = reader.renders();
    const identity = reader.result();

    // A new object with identical serialized content is a no-op landing: no wave, same identity.
    act(() => {
      rows.insert({ id: 'row-1', kept: 'kept', removed: 'remove-me', value: { count: 1 } });
    });
    expect(reader.renders() - before).toBe(0);
    expect(reader.result()).toBe(identity);

    // The same shape with a different serialized value is a real change.
    act(() => {
      rows.insert({ id: 'row-1', kept: 'kept', removed: 'remove-me', value: { count: 2 } });
    });
    expect(reader.renders() - before).toBe(1);
    expect(reader.result()).toEqual({ id: 'row-1', kept: 'kept', removed: 'remove-me', value: { count: 2 } });

    // An explicit field removal is a change of its own: the reader loses the field in one wave.
    act(() => {
      getApplyRuntime().commit(createCommitEnvelope([{ kind: 'patch', model: 'SpecCoreEdgeDiff', id: 'row-1', patch: {}, remove: ['removed'] }]));
    });
    expect(reader.renders() - before).toBe(2);
    expect(reader.result()).toEqual({ id: 'row-1', kept: 'kept', value: { count: 2 } });
    reader.unmount();
  });
});

describe('upsert resolution', () => {
  type Job = { id: string; label: string; status: string };
  type PatchInput = { id: string; status: string };
  type StatusData = { jobStatus: Job };
  type StatusVariables = { id: string };
  const statusDocument: TypedDocumentNode<StatusData, StatusVariables> = { kind: Kind.DOCUMENT, definitions: [] };
  const JobSchema = defineShape<Job>()({ label: f.str(), status: f.str() });

  it('coerces a numeric id and keeps row identity for an identical landing', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineModelRuntime({
      id: 'SpecCoreEdgeUpsertId',
      name: 'SpecCoreEdgeUpsertId',
      fields: { label: f.str() }
    });
    rows.insert({ id: 7 as never, label: 'coerced' });
    expect(rows.find('7')).toEqual({ id: '7', label: 'coerced' });

    const reader = renderCounted(() => rows.use.find('7'));
    const before = reader.renders();
    const identity = reader.result();
    act(() => {
      rows.insert({ id: '7', label: 'coerced' });
    });
    expect(reader.renders() - before).toBe(0);
    expect(reader.result()).toBe(identity);
    reader.unmount();
  });

  it('overlays operation-owned fields onto a snapshot while the mutation is in flight', async () => {
    let resolveMutation!: (value: { data: StatusData }) => void;
    const transport = createMockTransport({
      mutation: <TData,>() =>
        new Promise<{ data: TData }>(resolvePromise => {
          resolveMutation = resolvePromise as never;
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const jobs = defineModel('SpecCoreEdgeOwnedFields', {
      schema: JobSchema,
      actions: owner => ({
        change: owner.gql.action(statusDocument, {
          mode: 'request',
          result: 'jobStatus',
          variables: (input: PatchInput) => ({ id: input.id }),
          optimistic: { root: { update: { select: ({ input }) => ({ id: input.id, patch: { status: input.status } }) } } },
          root: { update: { select: ({ data }) => ({ id: data.jobStatus.id, patch: { status: data.jobStatus.status } }) } }
        })
      })
    });
    jobs.insert({ id: 'job-1', label: 'original', status: 'queued' });

    let pending!: Promise<unknown>;
    act(() => {
      pending = jobs.actions.change.run({ id: 'job-1', status: 'sending' });
    });
    expect(jobs.find('job-1')).toEqual({ id: 'job-1', label: 'original', status: 'sending' });

    // A snapshot from another channel lands mid-flight: the owned field keeps the optimistic
    // value, the unowned field takes the incoming one.
    act(() => {
      jobs.insert({ id: 'job-1', label: 'renamed', status: 'stomped' });
    });
    expect(jobs.find('job-1')).toEqual({ id: 'job-1', label: 'renamed', status: 'sending' });

    // Once the operation closes the same snapshot value is no longer overlaid.
    await act(async () => {
      resolveMutation({ data: { jobStatus: { id: 'job-1', label: 'original', status: 'sent' } } });
      await pending;
    });
    expect(jobs.find('job-1')).toEqual({ id: 'job-1', label: 'renamed', status: 'sent' });
    act(() => {
      jobs.insert({ id: 'job-1', label: 'renamed', status: 'stomped' });
    });
    expect(jobs.find('job-1')).toEqual({ id: 'job-1', label: 'renamed', status: 'stomped' });
  });
});

describe('declared write policies over landed snapshots', () => {
  const createGuarded = (id: string) =>
    defineModelRuntime({
      id,
      name: id,
      fields: { label: f.str(), meta: f.raw<ObjectValue | unknown[]>(), sequence: f.raw<unknown>().nullable(), keyed: f.raw<ObjectValue>() },
      write: {
        groups: [
          { fields: ['label'] as const, policy: 'server' as const },
          { fields: ['meta'] as const, policy: { monotonic: { present: 'meta.value' } } },
          { fields: ['sequence'] as const, policy: { monotonic: { tuple: ['sequence'] as [string] } } },
          { fields: ['keyed'] as const, policy: { keys: { value: 'continuity' as const } } }
        ]
      }
    });

  it('applies server, nested-present, numeric tuple, and nested-key policies to a second landing', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = createGuarded('SpecCoreEdgePolicies');
    rows.insert({ id: 'row-1', label: 'old', meta: { value: 1 }, sequence: null, keyed: { value: 'old' } });

    rows.insert({ id: 'row-1', label: 'new', meta: [], sequence: 1, keyed: { value: 'new' } });

    expect(rows.find('row-1')).toEqual({
      id: 'row-1',
      label: 'new',
      meta: { value: 1 },
      sequence: 1,
      keyed: { value: 'new' }
    });

    // A null tuple value never outranks a landed number.
    rows.insert({ id: 'row-1', label: 'new', meta: { value: 1 }, sequence: null, keyed: { value: 'new' } });
    expect(rows.find('row-1')).toMatchObject({ sequence: 1 });
  });

  it('keeps a null tuple over null and orders codepoint tuple values', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = createGuarded('SpecCoreEdgePolicyTuples');
    rows.insert({ id: 'row-null', label: 'x', meta: { value: 1 }, sequence: null, keyed: { value: 'x' } });
    rows.insert({ id: 'row-null', label: 'x', meta: { value: 1 }, sequence: null, keyed: { value: 'x' } });
    expect(rows.find('row-null')).toMatchObject({ sequence: null });

    rows.insert({ id: 'row-str', label: 'x', meta: { value: 1 }, sequence: 'a', keyed: { value: 'x' } });
    rows.insert({ id: 'row-str', label: 'x', meta: { value: 1 }, sequence: 'b', keyed: { value: 'x' } });
    expect(rows.find('row-str')).toMatchObject({ sequence: 'b' });
    rows.insert({ id: 'row-str', label: 'x', meta: { value: 1 }, sequence: 'a', keyed: { value: 'x' } });
    expect(rows.find('row-str')).toMatchObject({ sequence: 'b' });
  });
});

describe('query retry timeline', () => {
  type Row = { id: string; bucket: string; label: string };
  const document = { kind: 'Document', definitions: [] } as never;

  it('retries a network-classified failure on the backoff timeline and stops at the budget', async () => {
    jest.useFakeTimers();
    try {
      const callTimes: number[] = [];
      const startedAt = Date.now();
      const transport = createMockTransport({
        query: async <TData,>() => {
          void ((): TData => undefined as never);
          callTimes.push(Date.now() - startedAt);
          throw new Error('offline');
        }
      });
      configureDb({
        storage: createMemoryPlane(),
        transport,
        defaults: { retry: { query: { classify: () => 'network', budgets: { network: 1 } } } }
      });
      const rows = defineModelRuntime({
        id: 'SpecCoreEdgeRetry',
        name: 'SpecCoreEdgeRetry',
        fields: { bucket: f.str(), label: f.str() }
      });
      const query = rows.query<{ rows: Row[] }, { scope: string }, string, Row>('list', {
        document,
        key: 'core-edge-retry',
        vars: scope => ({ scope }),
        select: data => data.rows
      });
      const reader = renderCountedInProvider(() => query.use('a'));
      await settle();
      expect(callTimes).toEqual([0]);

      await act(async () => {
        jest.advanceTimersByTime(999);
      });
      await settle();
      expect(callTimes).toEqual([0]);

      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      await settle();
      expect(callTimes).toEqual([0, 1000]);

      // The network budget of 1 is spent: no third attempt however long the app waits.
      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });
      await settle();
      expect(callTimes).toEqual([0, 1000]);
      reader.unmount();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('commit delivery after reader teardown', () => {
  it('keeps delivering committed values to the surviving reader after another reader unmounts', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineModelRuntime({
      id: 'SpecCoreEdgeTeardown',
      name: 'SpecCoreEdgeTeardown',
      fields: { label: f.str() }
    });
    rows.insert({ id: 'row-1', label: 'first' });
    const leaving = renderCounted(() => rows.use.find('row-1'));
    const surviving = renderCounted(() => rows.use.find('row-1'));
    expect(leaving.result()).toEqual({ id: 'row-1', label: 'first' });

    leaving.unmount();
    const before = surviving.renders();
    act(() => {
      rows.update('row-1', { label: 'second' });
    });
    expect(surviving.renders() - before).toBe(1);
    expect(surviving.result()).toEqual({ id: 'row-1', label: 'second' });
    surviving.unmount();
  });
});

describe('sync error containment', () => {
  type BucketRow = { id: string; bucket: string };
  type ListResponse = { rows: BucketRow[] | null };
  const listDocument: TypedDocumentNode<ListResponse, { bucket: string }> = { kind: Kind.DOCUMENT, definitions: [] };
  const BucketSchema = defineShape<BucketRow>()({ bucket: f.str() });

  it('delivers the source error to onSyncError and contains a throwing observer and logger', async () => {
    const received: Array<{ message: string; context: unknown }> = [];
    let served = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        served += 1;
        return { data: (served === 1 ? { rows: [{ id: 'row-1', bucket: 'a' }] } : { rows: null }) as TData };
      }
    });
    configureDb({
      storage: createMemoryPlane(),
      transport,
      defaults: {
        onSyncError: (error, context) => {
          received.push({ message: error.message, context });
          throw new Error('observer failed');
        }
      },
      logger: {
        debug: () => undefined,
        error: () => {
          throw new Error('logger failed');
        }
      }
    });
    const rows = defineModel('SpecCoreEdgeSyncError', {
      schema: BucketSchema,
      relations: owner => ({
        byBucket: {
          by: { bucket: 'bucket' },
          remote: owner.gql.list(listDocument, {
            variables: (scope: { bucket: string }) => scope,
            select: data => data.rows
          })
        }
      })
    });
    const relation = rows.byBucket({ bucket: 'a' });
    await relation.fetch();
    expect(relation.read().map(row => row.id)).toEqual(['row-1']);

    // The pipeline reports its own error even though the observer and the logger both throw.
    await expect(relation.refresh()).rejects.toThrow('nullish list payload');
    expect(received).toEqual([
      {
        message: 'react-native-dblayer: relation landing refused - nullish list payload',
        context: { source: 'query', model: 'SpecCoreEdgeSyncError', key: 'byBucket' }
      }
    ]);
    expect(relation.read().map(row => row.id)).toEqual(['row-1']);
  });
});
