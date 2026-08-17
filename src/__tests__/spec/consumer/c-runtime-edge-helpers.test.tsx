import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import {
  belongsTo,
  bootDb,
  computeSchemaFingerprints,
  configureDb,
  createModelContext,
  DB_FORMAT_VERSION,
  defineModel,
  defineModelRuntime,
  defineShape,
  encodePersistence,
  f,
  getCommitBus,
  getDbRuntimeConfig,
  resumeFetchReaders,
  useMergedScopeRows,
  writePersistenceManifest,
  type DbTransport
} from '../../testApi';
import { compositeStorageKey, createMemoryPlane, createMockTransport, renderCounted, renderCountedInProvider, settle, setupSpecRuntime } from '../helpers/harness';

type Row = { id: string; bucket: string; label: string };
type QueryScope = { scope: string };

const document = { kind: 'Document', definitions: [] } as never;

const createBucketRows = (suffix: string) =>
  defineModelRuntime({
    id: `SpecRuntimeEdgeRows${suffix}`,
    name: `SpecRuntimeEdgeRows${suffix}`,
    fields: { bucket: f.str(), label: f.str() },
    scopes: { byBucket: { by: { bucket: 'bucket' } } }
  });

const createModelQuery = (rows: ReturnType<typeof createBucketRows>, key: string, options: { resumeStaleTime?: number | null } = {}) =>
  rows.query<{ rows: Row[] }, QueryScope, string, Row>('list', {
    document,
    key,
    vars: scope => ({ scope }),
    select: data => data.rows,
    ...options
  });

describe('commits before runtime configuration', () => {
  // This describe must stay first in the file: configuredness survives resetRuntime, so the
  // unconfigured branch is only reachable before the first configureDb of the suite process.
  it('ignores a loss published before configureDb and prunes the same loss once configured', async () => {
    expect(() => getDbRuntimeConfig()).toThrow('configureDb must be called');
    // No public write API exists before configureDb, so the pre-configuration loss can only be
    // produced on the bus itself; the paired flow below proves the same batch shape works after.
    getCommitBus().publish({
      rows: [{ model: 'SpecRuntimeEdgeRowsPreConfigure', id: 'row-1', fields: null, kind: 'destroy' }],
      scopes: [],
      pending: [],
      scopeChanges: []
    });

    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { rows: [{ id: 'row-1', bucket: 'a', label: 'first' }] } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createBucketRows('PostConfigure');
    const query = createModelQuery(rows, 'runtime-edge-post-configure');
    const reader = renderCountedInProvider(() => query.use('a'));
    await settle();
    await settle(1, { macro: true });
    expect(transport.calls.map(call => (call.operation as { variables: QueryScope }).variables)).toEqual([{ scope: 'a' }]);
    expect(query.read('a')).toEqual([{ id: 'row-1', bucket: 'a', label: 'first' }]);

    act(() => {
      rows.destroy('row-1');
    });
    await settle();
    await settle(1, { macro: true });
    expect(transport.calls.map(call => (call.operation as { variables: QueryScope }).variables)).toEqual([{ scope: 'a' }, { scope: 'a' }]);
    reader.unmount();
  });
});

describe('reader identity across commits', () => {
  it('keeps criteria reader identity through a non-matching commit and emits matches in one wave', () => {
    setupSpecRuntime();
    const rows = createBucketRows('Identity');
    rows.insert({ id: 'row-1', bucket: 'a', label: 'first' });
    const reader = renderCounted(() => rows.use.where({ bucket: 'a' }).orderBy('label').rows());
    expect(reader.result().map(row => row.id)).toEqual(['row-1']);
    const stable = reader.result();
    const before = reader.renders();

    act(() => {
      rows.insert({ id: 'row-2', bucket: 'b', label: 'outside' });
    });
    expect(reader.renders() - before).toBe(0);
    expect(reader.result()).toBe(stable);

    act(() => {
      rows.insert({ id: 'row-3', bucket: 'a', label: 'second' });
    });
    expect(reader.renders() - before).toBe(1);
    expect(reader.result().map(row => row.id)).toEqual(['row-1', 'row-3']);
    reader.unmount();
  });
});

describe('relation declaration memoization', () => {
  type AuthorRow = { id: string; name: string };

  it('resolves the relations factory once across repeated related reads', () => {
    setupSpecRuntime();
    let factoryCalls = 0;
    const authors = defineModelRuntime({
      id: 'SpecRuntimeEdgeRelAuthors',
      name: 'SpecRuntimeEdgeRelAuthors',
      fields: { name: f.str() }
    });
    const posts = defineModelRuntime({
      id: 'SpecRuntimeEdgeRelPosts',
      name: 'SpecRuntimeEdgeRelPosts',
      fields: { authorId: f.str(), title: f.str() },
      relations: () => {
        factoryCalls += 1;
        return { author: belongsTo(authors, { foreignKey: 'authorId' }) };
      }
    });
    authors.insert({ id: 'u-1', name: 'Ann' });
    posts.insertMany([
      { id: 'p-1', authorId: 'u-1', title: 'first' },
      { id: 'p-2', authorId: 'u-1', title: 'second' }
    ]);
    const first = renderCounted(() => posts.use.related('p-1', 'author') as AuthorRow | undefined);
    const second = renderCounted(() => posts.use.related('p-2', 'author') as AuthorRow | undefined);
    expect(first.result()?.name).toBe('Ann');
    expect(second.result()?.name).toBe('Ann');

    act(() => {
      authors.update('u-1', { name: 'Ann Updated' });
    });
    expect(first.result()?.name).toBe('Ann Updated');
    expect(second.result()?.name).toBe('Ann Updated');
    expect(factoryCalls).toBe(1);
    first.unmount();
    second.unmount();
  });
});

describe('causal admission of stale responses', () => {
  type FetchRow = { id: string; changed: string; untouched: string };
  type FetchResponse = { row: FetchRow };
  const singleDocument: TypedDocumentNode<FetchResponse, { request: string }> = { kind: Kind.DOCUMENT, definitions: [] };
  const FetchSchema = defineShape<FetchRow>()({ changed: f.str(), untouched: f.str() });

  const createFetchFixture = (suffix: string) => {
    const deferred = new Map<string, (response: FetchResponse) => void>();
    const transport = createMockTransport({
      query: async <TData,>(operation: Parameters<DbTransport['query']>[0]) =>
        await new Promise<{ data: TData }>(resolve => {
          deferred.set((operation.variables as { request: string }).request, response => resolve({ data: response as TData }));
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = defineModel(`SpecRuntimeEdgeCausal${suffix}`, {
      schema: FetchSchema,
      relations: owner => ({
        remote: {
          remote: owner.gql.single(singleDocument, { variables: (params: { request: string }) => params, select: data => data.row })
        }
      })
    });
    rows.insert({ id: 'row-1', changed: 'base', untouched: 'base' });
    const start = (name: string): Promise<void> => rows.remote({ request: name }).fetch();
    const resolve = async (name: string, row: FetchRow, pending: Promise<void>): Promise<void> => {
      await act(async () => {
        deferred.get(name)!({ row });
        await pending;
      });
    };
    return { rows, start, resolve };
  };

  it('lands an uncontested response and keeps a row destroyed mid-flight absent', async () => {
    const fixture = createFetchFixture('DestroyRace');
    const clean = fixture.start('clean');
    await fixture.resolve('clean', { id: 'row-1', changed: 'clean', untouched: 'clean' }, clean);
    expect(fixture.rows.find('row-1')).toEqual({ id: 'row-1', changed: 'clean', untouched: 'clean' });

    const slow = fixture.start('slow');
    act(() => {
      fixture.rows.destroy('row-1');
    });
    await fixture.resolve('slow', { id: 'row-1', changed: 'stale', untouched: 'stale' }, slow);
    expect(fixture.rows.find('row-1')).toBeUndefined();
  });

  it('keeps a row re-created mid-flight over the stale response', async () => {
    const fixture = createFetchFixture('RecreateRace');
    const slow = fixture.start('slow');

    act(() => {
      fixture.rows.destroy('row-1');
      fixture.rows.insert({ id: 'row-1', changed: 'local', untouched: 'local' });
    });
    await fixture.resolve('slow', { id: 'row-1', changed: 'stale', untouched: 'stale' }, slow);

    expect(fixture.rows.find('row-1')).toEqual({ id: 'row-1', changed: 'local', untouched: 'local' });
  });

  it('evicts locally-updated fields from a stale response while accepting its untouched fields', async () => {
    const fixture = createFetchFixture('FieldRace');
    const slow = fixture.start('slow');

    act(() => {
      fixture.rows.update('row-1', { changed: 'local' });
    });
    await fixture.resolve('slow', { id: 'row-1', changed: 'remote', untouched: 'accepted' }, slow);

    expect(fixture.rows.find('row-1')).toEqual({ id: 'row-1', changed: 'local', untouched: 'accepted' });
  });
});

describe('causal admission of write-plan landings', () => {
  type Target = { id: string; alpha: string; beta: string };
  type ActionData = { rootAction: { root: { id: string; label: string } } };
  type ActionVariables = { input: { value: string } };
  const actionDocument: TypedDocumentNode<ActionData, ActionVariables> = { kind: Kind.DOCUMENT, definitions: [] };
  const TargetSchema = defineShape<Target>()({ alpha: f.str(), beta: f.str() });
  const RootSchema = defineShape<{ id: string; label: string }>()({ label: f.str() });

  const createPlanFixture = (suffix: string, write: (plan: { update(model: never, id: string, patch: object): void; destroy(model: never, id: string): void }, target: never) => void) => {
    let resolveMutation!: (value: { data: ActionData }) => void;
    const transport = createMockTransport({
      mutation: <TData,>() =>
        new Promise<{ data: TData }>(resolvePromise => {
          resolveMutation = resolvePromise as never;
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const target = defineModel(`SpecRuntimeEdgePlanTarget${suffix}`, { schema: TargetSchema });
    const root = defineModel(`SpecRuntimeEdgePlanRoot${suffix}`, {
      schema: RootSchema,
      actions: owner => ({
        apply: owner.gql.action(actionDocument, {
          mode: 'request',
          result: 'rootAction',
          variables: (input: { value: string }) => ({ input }),
          root: { insert: { select: ({ data }) => data.rootAction.root } },
          write: (_context, plan) => write(plan as never, target as never)
        })
      })
    });
    target.insert({ id: 't-1', alpha: 'base', beta: 'base' });
    const land = async (pending: Promise<unknown>): Promise<void> => {
      await act(async () => {
        resolveMutation({ data: { rootAction: { root: { id: 'root-1', label: 'landed' } } } });
        await pending;
      });
    };
    return { target, root, land };
  };

  it('drops locally-updated patch fields from a landing and applies the rest', async () => {
    const fixture = createPlanFixture('PatchPartial', (plan, target) => plan.update(target, 't-1', { alpha: 'planned', beta: 'planned' }));
    let pending!: Promise<unknown>;
    act(() => {
      pending = fixture.root.actions.apply.run({ value: 'go' });
    });
    act(() => {
      fixture.target.update('t-1', { alpha: 'local' });
    });
    await fixture.land(pending);

    expect(fixture.target.find('t-1')).toEqual({ id: 't-1', alpha: 'local', beta: 'planned' });
  });

  it('drops a fully-contested patch and leaves the local row intact', async () => {
    const fixture = createPlanFixture('PatchFull', (plan, target) => plan.update(target, 't-1', { alpha: 'planned', beta: 'planned' }));
    let pending!: Promise<unknown>;
    act(() => {
      pending = fixture.root.actions.apply.run({ value: 'go' });
    });
    act(() => {
      fixture.target.update('t-1', { alpha: 'local', beta: 'local' });
    });
    await fixture.land(pending);

    expect(fixture.target.find('t-1')).toEqual({ id: 't-1', alpha: 'local', beta: 'local' });
  });

  it('drops a planned destroy for a row changed mid-flight and lands it uncontested', async () => {
    const fixture = createPlanFixture('Destroy', (plan, target) => plan.destroy(target, 't-1'));
    let contested!: Promise<unknown>;
    act(() => {
      contested = fixture.root.actions.apply.run({ value: 'first' });
    });
    act(() => {
      fixture.target.update('t-1', { alpha: 'local' });
    });
    await fixture.land(contested);
    expect(fixture.target.find('t-1')).toEqual({ id: 't-1', alpha: 'local', beta: 'base' });

    let uncontested!: Promise<unknown>;
    act(() => {
      uncontested = fixture.root.actions.apply.run({ value: 'second' });
    });
    await fixture.land(uncontested);
    expect(fixture.target.find('t-1')).toBeUndefined();
  });

  it('rejects revision notes outside an active apply', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    // The apply runtime brackets every commit with beginApply/commitApply, so no public write can
    // note a revision outside an apply or open a second apply; the guards are only reachable here.
    const context = createModelContext<{ id: string }>({
      modelId: 'SpecRuntimeEdgeRevisionGuards',
      scopeNames: [],
      relations: () => ({}),
      applyWriteGate: (_previous, incoming) => incoming
    });
    expect(() => context.revisions.notePut('row-1', ['changed'], false)).toThrow('SpecRuntimeEdgeRevisionGuards: revision apply is not active');
    expect(() => context.revisions.noteDestroy('row-1')).toThrow('SpecRuntimeEdgeRevisionGuards: revision apply is not active');
    expect(() => context.revisions.commitApply()).toThrow('SpecRuntimeEdgeRevisionGuards: revision apply is not active');
    context.revisions.beginApply(2);
    expect(() => context.revisions.beginApply(3)).toThrow('SpecRuntimeEdgeRevisionGuards: revision apply already active');
    context.revisions.abortApply();
  });
});

describe('error loading classification', () => {
  it('classifies a failed first fetch as error and a landed fetch as ready', async () => {
    let mode: 'fail' | 'serve' = 'fail';
    const transport = createMockTransport({
      query: async <TData,>() => {
        if (mode === 'fail') throw new Error('offline');
        return { data: { rows: [{ id: 'row-1', bucket: 'a', label: 'first' }] } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createBucketRows('LoadingPhase');
    const query = createModelQuery(rows, 'runtime-edge-loading-phase');

    const failing = renderCountedInProvider(() => query.use('a'));
    await settle();
    await settle(2, { macro: true });
    expect(failing.result().loadingState).toMatchObject({ phase: 'error', showErrorBanner: true, hasData: false, showSkeleton: false });
    expect(failing.result().error?.message).toBe('offline');
    failing.unmount();

    mode = 'serve';
    const serving = renderCountedInProvider(() => query.use('b'));
    await settle();
    await settle(2, { macro: true });
    expect(serving.result().loadingState).toMatchObject({ phase: 'ready', hasData: true, showErrorBanner: false });
    expect((serving.result().data as unknown as Row[]).map(row => row.id)).toEqual(['row-1']);
    serving.unmount();
  });
});

describe('projected row reuse', () => {
  it('re-renders a render-key reader only when a tracked field changes', () => {
    setupSpecRuntime();
    const rows = createBucketRows('RenderKeys');
    rows.insert({ id: 'row-1', bucket: 'a', label: 'first' });
    const reader = renderCounted(() => rows.use.find('row-1', { renderKeys: ['label'] }));
    const identity = reader.result();
    const before = reader.renders();

    act(() => {
      rows.update('row-1', { bucket: 'b' });
    });
    expect(reader.renders() - before).toBe(0);
    expect(reader.result()).toBe(identity);

    act(() => {
      rows.update('row-1', { label: 'second' });
    });
    expect(reader.renders() - before).toBe(1);
    expect(reader.result()).toMatchObject({ label: 'second', bucket: 'b' });
    reader.unmount();
  });

  it('emits one wave when a full-row reader gains a field', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineModelRuntime({
      id: 'SpecRuntimeEdgeFieldSet',
      name: 'SpecRuntimeEdgeFieldSet',
      fields: { label: f.str(), extra: f.str().optional() }
    });
    rows.insert({ id: 'row-1', label: 'first' });
    const reader = renderCounted(() => rows.use.find('row-1'));
    const before = reader.renders();

    act(() => {
      rows.update('row-1', { extra: 'added' });
    });
    expect(reader.renders() - before).toBe(1);
    expect(reader.result()).toEqual({ id: 'row-1', label: 'first', extra: 'added' });
    reader.unmount();
  });
});

describe('live reads across mount-time commits', () => {
  it('serves a row committed by a sibling while the reader was mounting', () => {
    setupSpecRuntime();
    const rows = createBucketRows('MountCommit');
    let latest: Row | undefined;
    const Reader = () => {
      latest = rows.use.find('row-1');
      return null;
    };
    const Late = () => {
      React.useLayoutEffect(() => {
        rows.insert({ id: 'row-1', bucket: 'a', label: 'inserted-during-mount' });
      }, []);
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(React.Fragment, null, React.createElement(Late), React.createElement(Reader)));
    });

    expect(latest).toEqual({ id: 'row-1', bucket: 'a', label: 'inserted-during-mount' });
    act(() => root.unmount());
  });

  it('tracks the pending state of a row operation from start to landing', async () => {
    type Job = { id: string; label: string };
    type StatusData = { jobStatus: Job };
    const statusDocument: TypedDocumentNode<StatusData, { id: string }> = { kind: Kind.DOCUMENT, definitions: [] };
    let resolveMutation!: (value: { data: StatusData }) => void;
    const transport = createMockTransport({
      mutation: <TData,>() =>
        new Promise<{ data: TData }>(resolvePromise => {
          resolveMutation = resolvePromise as never;
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const jobs = defineModel('SpecRuntimeEdgePending', {
      schema: defineShape<Job>()({ label: f.str() }),
      actions: owner => ({
        rename: owner.gql.action(statusDocument, {
          mode: 'request',
          result: 'jobStatus',
          variables: (input: { id: string; label: string }) => ({ id: input.id }),
          optimistic: { root: { update: { select: ({ input }) => ({ id: input.id, patch: { label: input.label } }) } } },
          root: { update: { select: ({ data }) => ({ id: data.jobStatus.id, patch: { label: data.jobStatus.label } }) } }
        })
      })
    });
    jobs.insert({ id: 'job-1', label: 'original' });
    const reader = renderCounted(() => jobs.operation('job-1').use().pending);
    expect(reader.result()).toBe(false);

    let pending!: Promise<unknown>;
    act(() => {
      pending = jobs.actions.rename.run({ id: 'job-1', label: 'renamed' });
    });
    expect(reader.result()).toBe(true);

    await act(async () => {
      resolveMutation({ data: { jobStatus: { id: 'job-1', label: 'renamed' } } });
      await pending;
    });
    expect(reader.result()).toBe(false);
    expect(jobs.find('job-1')).toEqual({ id: 'job-1', label: 'renamed' });
    reader.unmount();
  });
});

describe('scope reader dependencies', () => {
  it('recomputes a scope reader for its own scope key only', () => {
    setupSpecRuntime();
    const rows = createBucketRows('ScopeDep');
    const reader = renderCounted(() => rows.scopes.byBucket.use({ bucket: 'a' }));
    expect(reader.result()).toEqual([]);
    const before = reader.renders();

    act(() => {
      rows.insert({ id: 'row-b', bucket: 'b', label: 'other' });
    });
    expect(reader.renders() - before).toBe(0);
    expect(reader.result()).toEqual([]);

    act(() => {
      rows.insert({ id: 'row-a', bucket: 'a', label: 'mine' });
    });
    expect(reader.renders() - before).toBe(1);
    expect(reader.result().map(row => row.id)).toEqual(['row-a']);
    reader.unmount();
  });
});

describe('bounded model read ordering', () => {
  it('orders and bounds imperative where reads by the declared keys', () => {
    setupSpecRuntime();
    const rows = createBucketRows('Ordering');
    rows.insertMany([
      { id: 'row-b', bucket: 'a', label: 'beta' },
      { id: 'row-a', bucket: 'a', label: 'alpha' },
      { id: 'row-c', bucket: 'a', label: 'gamma' }
    ]);

    expect(rows.where({ bucket: 'a' }, { orderBy: { field: 'label', direction: 'asc' } }).map(row => row.id)).toEqual(['row-a', 'row-b', 'row-c']);
    expect(rows.where({ bucket: 'a' }, { orderBy: { field: 'label', direction: 'desc' }, limit: 1 }).map(row => row.id)).toEqual(['row-c']);
    expect(rows.where({ bucket: 'a' }, { orderBy: { field: 'label', direction: 'asc' }, limit: -1 })).toEqual([]);
    expect(rows.where({ bucket: 'a' }).map(row => row.id).sort()).toEqual(['row-a', 'row-b', 'row-c']);
  });
});

describe('temp row protection at boot', () => {
  it('quarantines an ownerless temp row at boot and keeps a model-protected one', async () => {
    const storage = createMemoryPlane();
    storage.set(compositeStorageKey('dbl:', 'row', 'SpecRuntimeEdgeTempUnprotected', 'temp-orphan'), encodePersistence({ id: 'temp-orphan', label: 'orphan' }));
    storage.set(compositeStorageKey('dbl:', 'row', 'SpecRuntimeEdgeTempGuarded', 'temp-keep'), encodePersistence({ id: 'temp-keep', label: 'kept' }));
    configureDb({ storage, transport: createMockTransport() });
    const unprotected = defineModelRuntime({
      id: 'SpecRuntimeEdgeTempUnprotected',
      name: 'SpecRuntimeEdgeTempUnprotected',
      fields: { label: f.str() }
    });
    const guarded = defineModelRuntime({
      id: 'SpecRuntimeEdgeTempGuarded',
      name: 'SpecRuntimeEdgeTempGuarded',
      fields: { label: f.str() },
      maintenance: { dropTempRowsAfterMs: 60_000, protectTempRows: () => new Set(['temp-keep']) }
    });
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });

    await bootDb();

    expect(unprotected.find('temp-orphan')).toBeUndefined();
    expect(guarded.find('temp-keep')).toEqual({ id: 'temp-keep', label: 'kept' });
  });
});

describe('derived scope membership', () => {
  it('attaches membership by the derived value of the final row, not the stored copy', () => {
    setupSpecRuntime();
    const rows = defineModelRuntime({
      id: 'SpecRuntimeEdgeDerivedScope',
      name: 'SpecRuntimeEdgeDerivedScope',
      fields: {
        source: f.str(),
        derived: f.custom<string, { source?: string }>(input => input.source ?? '')
      },
      scopes: { byDerived: { by: { value: 'derived' } } },
      write: { groups: [{ fields: ['source'] as const, policy: 'local' as const }] }
    });
    rows.insert({ id: 'row-1', source: 'source' } as never);
    expect(rows.scopes.byDerived.read({ value: 'source' }).map(row => row.id)).toEqual(['row-1']);

    // The local policy restores source, leaving a stale derived copy in the stored row; the
    // membership must follow the restored source, not the stale stored derived value.
    rows.insert({ id: 'row-1', source: 'incoming' } as never);
    expect(rows.find('row-1')).toMatchObject({ source: 'source' });
    expect(rows.scopes.byDerived.read({ value: 'source' }).map(row => row.id)).toEqual(['row-1']);
    expect(rows.scopes.byDerived.read({ value: 'incoming' })).toEqual([]);

    // A patch is the local-policy write path: membership follows the moved source.
    rows.update('row-1', { source: 'moved' } as never);
    expect(rows.scopes.byDerived.read({ value: 'moved' }).map(row => row.id)).toEqual(['row-1']);
    expect(rows.scopes.byDerived.read({ value: 'source' })).toEqual([]);
  });
});

describe('criteria normalization', () => {
  it('coerces operand types inside nested logical criteria', () => {
    setupSpecRuntime();
    const rows = defineModelRuntime({
      id: 'SpecRuntimeEdgeCriteria',
      name: 'SpecRuntimeEdgeCriteria',
      fields: { count: f.num(), raw: f.str() }
    });
    rows.insertMany([
      { id: '7', count: 2, raw: 'value' },
      { id: '8', count: 3, raw: 'other' }
    ]);

    const nested = renderCounted(() => rows.use.where({ and: [null as never, { id: 7 as never }, { raw: 'value' }] } as never).rows());
    expect(nested.result().map(row => row.id)).toEqual(['7']);
    nested.unmount();

    const membership = renderCounted(() => rows.use.where({ count: { in: [2] } } as never).rows());
    expect(membership.result().map(row => row.id)).toEqual(['7']);
    membership.unmount();

    expect(rows.where(null as never).map(row => row.id).sort()).toEqual(['7', '8']);
  });
});

describe('loss-driven refetch of active readers', () => {
  const createLossFixture = (suffix: string, key: string, options: { failRefetch?: boolean } = {}) => {
    const served = new Map<string, number>();
    const transport = createMockTransport({
      query: async <TData,>(operation: Parameters<DbTransport['query']>[0]) => {
        const scope = (operation.variables as QueryScope).scope;
        const call = (served.get(scope) ?? 0) + 1;
        served.set(scope, call);
        if (options.failRefetch && call > 1) throw new Error('refetch failed');
        return { data: { rows: [{ id: `row-${scope}-${call}`, bucket: scope, label: scope }] } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createBucketRows(suffix);
    const query = createModelQuery(rows, key);
    const variablesSeen = () => transport.calls.map(call => (call.operation as { variables: QueryScope }).variables);
    return { transport, rows, query, variablesSeen };
  };

  it('refetches only the readers of the destroyed chain', async () => {
    const fixture = createLossFixture('LossTargets', 'runtime-edge-loss-targets');
    const readers = renderCountedInProvider(() => ({ a: fixture.query.use('a'), b: fixture.query.use('b') }));
    await settle();
    await settle(1, { macro: true });
    expect(fixture.variablesSeen()).toEqual([{ scope: 'a' }, { scope: 'b' }]);
    expect(fixture.query.read('a')).toEqual([{ id: 'row-a-1', bucket: 'a', label: 'a' }]);

    act(() => {
      fixture.rows.destroy('row-a-1');
    });
    await settle();
    await settle(1, { macro: true });

    expect(fixture.variablesSeen()).toEqual([{ scope: 'a' }, { scope: 'b' }, { scope: 'a' }]);
    expect(fixture.query.read('a')).toEqual([{ id: 'row-a-2', bucket: 'a', label: 'a' }]);
    expect(fixture.query.read('b')).toEqual([{ id: 'row-b-1', bucket: 'b', label: 'b' }]);
    readers.unmount();
  });

  it('contains a rejected loss-driven refetch and keeps serving the survivors', async () => {
    const fixture = createLossFixture('LossRejected', 'runtime-edge-loss-rejected', { failRefetch: true });
    const reader = renderCountedInProvider(() => fixture.query.use('a'));
    await settle();
    await settle(1, { macro: true });
    expect(fixture.query.read('a')).toEqual([{ id: 'row-a-1', bucket: 'a', label: 'a' }]);

    act(() => {
      fixture.rows.destroy('row-a-1');
    });
    await settle();
    await settle(2, { macro: true });

    expect(fixture.variablesSeen()).toEqual([{ scope: 'a' }, { scope: 'a' }]);
    expect(fixture.query.read('a')).toEqual([]);
    act(() => {
      fixture.rows.insert({ id: 'row-after', bucket: 'a', label: 'still-works' });
    });
    expect(fixture.rows.find('row-after')).toEqual({ id: 'row-after', bucket: 'a', label: 'still-works' });
    reader.unmount();
  });
});

describe('foreground resume of active readers', () => {
  it('resumes only lapsed readers, honors cancellation, and releases unmounted readers', async () => {
    const transport = createMockTransport({
      query: async <TData,>(operation: Parameters<DbTransport['query']>[0]) => {
        const scope = (operation.variables as QueryScope).scope;
        return { data: { rows: [{ id: `row-${scope}`, bucket: scope, label: scope }] } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createBucketRows('Resume');
    const lapsed = createModelQuery(rows, 'runtime-edge-resume-lapsed', { resumeStaleTime: 0 });
    const fresh = createModelQuery(rows, 'runtime-edge-resume-fresh', { resumeStaleTime: 3_600_000 });
    const variablesSeen = () => transport.calls.map(call => (call.operation as { variables: QueryScope }).variables);
    const readers = renderCountedInProvider(() => ({ a: lapsed.use('a'), b: fresh.use('b') }));
    await settle();
    await settle(1, { macro: true });
    expect(variablesSeen()).toEqual([{ scope: 'a' }, { scope: 'b' }]);

    // A resume superseded before its first chunk refetches nobody.
    expect(await resumeFetchReaders(1, () => false)).toBe(0);
    await settle();
    expect(variablesSeen()).toEqual([{ scope: 'a' }, { scope: 'b' }]);

    // The provider-driven resume refetches the lapsed reader only.
    let resumed!: number;
    await act(async () => {
      resumed = await resumeFetchReaders(1, () => true);
    });
    await settle();
    await settle(1, { macro: true });
    expect(resumed).toBe(1);
    expect(variablesSeen()).toEqual([{ scope: 'a' }, { scope: 'b' }, { scope: 'a' }]);

    // Unmounted readers leave the registry: the next resume reaches nobody.
    readers.unmount();
    expect(await resumeFetchReaders(1, () => true)).toBe(0);
    await settle();
    expect(variablesSeen()).toEqual([{ scope: 'a' }, { scope: 'b' }, { scope: 'a' }]);
  });
});

describe('merged scope rows', () => {
  it('merges two scope reads with deduplication, comparator order, and stable identity', () => {
    setupSpecRuntime();
    const rows = createBucketRows('Merged');
    rows.insertMany([
      { id: 'row-2', bucket: 'a', label: 'b-label' },
      { id: 'row-1', bucket: 'b', label: 'a-label' },
      { id: 'row-2', bucket: 'a', label: 'b-label' }
    ]);
    const comparator = (left: Row, right: Row) => (left.label < right.label ? -1 : left.label > right.label ? 1 : 0);
    let latest: ReadonlyArray<Row> = [];
    const Probe = (_props: { tick: number }) => {
      const base = rows.scopes.byBucket.use({ bucket: 'a' });
      const extras = rows.scopes.byBucket.use({ bucket: 'b' });
      latest = useMergedScopeRows(base, [...extras, ...base], { comparator });
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(Probe, { tick: 0 }));
    });
    expect(latest.map(row => row.id)).toEqual(['row-1', 'row-2']);
    const first = latest;

    act(() => root.update(React.createElement(Probe, { tick: 1 })));
    expect(latest).toBe(first);
    expect(latest.map(row => row.id)).toEqual(['row-1', 'row-2']);

    act(() => {
      rows.insert({ id: 'row-3', bucket: 'a', label: '0-label' });
    });
    expect(latest.map(row => row.id)).toEqual(['row-3', 'row-1', 'row-2']);
    act(() => root.unmount());
  });
});
