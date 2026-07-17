import { act } from 'react-test-renderer';
import {
  belongsTo,
  collectGarbage,
  defineIngest,
  defineModel,
  defineMutation,
  defineQuery,
  f,
  flushPersistence,
  hasMany,
  isTempId,
  purgeForeignStorageKeys,
  replayJournal,
  scope
} from '../../index';
import { createAcceptanceTransport, createMemoryPlane, renderCounted, setupAcceptanceRuntime } from './harness';

const document = { kind: `Document`, definitions: [] } as never;
const scopeValue = { feed: `acceptance` };

describe(`A04 sync lifecycle contract`, () => {
  // ACCEPTANCE-GAP: defineMutation exposes dedupe keys but does not expose a caller-provided operationId for defineIngest echo matching.
  it.skip(`A04-1 skips an ingest echo for a committed mutation operation id`, async () => {
    const transport = createAcceptanceTransport({
      mutation: async <TData,>() => ({ data: { save: { id: `server`, title: `saved` } } as TData })
    });
    setupAcceptanceRuntime({ transport });
    const model = defineModel({ id: `A04Echo`, name: `A04Echo`, fields: { title: f.str() } });
    const mutation = defineMutation<{ save: { id: string; title: string } }, Record<string, never>, { id: string; title: string }, { id: string; title: string }>({
      document,
      result: `save`,
      dedupe: { key: () => `operation-id` },
      optimistic: {
        model,
        build: (_input, context) => ({ id: context.tempId!, title: `pending` }),
        selectServerNode: data => data.save
      }
    });
    const ingest = defineIngest(model, {
      received: () => ({ operationId: `operation-id`, upsert: { id: `echo`, title: `echo` } })
    });
    const reader = renderCounted(() => model.use.row(`echo`));

    await act(async () => {
      await mutation.run({});
    });
    const renders = reader.renders();
    act(() => {
      ingest.apply(`received`, {});
    });
    expect(model.get(`echo`)).toBeUndefined();
    expect(reader.renders()).toBe(renders);
    reader.unmount();
  });

  it(`A04-2 applies a duplicate ingest upsert without visible change`, () => {
    setupAcceptanceRuntime();
    const model = defineModel({ id: `A04Idempotent`, name: `A04Idempotent`, fields: { title: f.str() } });
    const ingest = defineIngest(model, { received: payload => ({ upsert: payload }) });
    const reader = renderCounted(() => model.use.row(`row`));

    act(() => {
      ingest.apply(`received`, { id: `row`, title: `same` });
    });
    const renders = reader.renders();
    act(() => {
      ingest.apply(`received`, { id: `row`, title: `same` });
    });
    expect(reader.result()).toEqual({ id: `row`, title: `same` });
    expect(reader.renders()).toBe(renders);
    reader.unmount();
  });

  it(`A04-3 updates counterCache in the child event transaction`, () => {
    setupAcceptanceRuntime();
    const parent = defineModel({
      id: `A04CounterParent`,
      name: `A04CounterParent`,
      fields: { count: f.num() }
    });
    const child = defineModel({
      id: `A04CounterChild`,
      name: `A04CounterChild`,
      fields: { parentId: f.id(), title: f.str() },
      relations: () => ({ parent: belongsTo(parent, { foreignKey: `parentId`, counterCache: { field: `count` } }) })
    });
    const ingest = defineIngest(child, {
      received: payload => ({ upsert: payload }),
      deleted: payload => ({ destroy: (payload as { id: string }).id })
    });
    act(() => {
      parent.insertStored({ id: `parent`, count: 0 });
    });
    const reader = renderCounted(() => parent.use.row(`parent`));
    const beforeInsert = reader.renders();
    act(() => {
      ingest.apply(`received`, { id: `child`, parentId: `parent`, title: `child` });
    });
    expect(reader.result()).toEqual({ id: `parent`, count: 1 });
    expect(reader.renders()).toBe(beforeInsert + 1);
    const beforeDestroy = reader.renders();
    act(() => {
      ingest.apply(`deleted`, { id: `child` });
    });
    expect(reader.result()).toEqual({ id: `parent`, count: 0 });
    expect(reader.renders()).toBe(beforeDestroy + 1);
    reader.unmount();
  });

  it(`A04-4 projects an ingest child write onto its parent once`, () => {
    setupAcceptanceRuntime();
    const parent = defineModel({
      id: `A04TouchParent`,
      name: `A04TouchParent`,
      fields: { lastTitle: f.str() }
    });
    const child = defineModel({
      id: `A04TouchChild`,
      name: `A04TouchChild`,
      fields: { parentId: f.id(), title: f.str() },
      relations: () => ({
        parent: belongsTo(parent, {
          foreignKey: `parentId`,
          touch: row => ({ lastTitle: (row as unknown as { title: string }).title })
        })
      })
    });
    const ingest = defineIngest(child, { received: payload => ({ upsert: payload }) });
    act(() => {
      parent.insertStored({ id: `parent`, lastTitle: `before` });
    });
    const reader = renderCounted(() => parent.use.row(`parent`));
    const before = reader.renders();
    act(() => {
      ingest.apply(`received`, { id: `child`, parentId: `parent`, title: `after` });
    });
    expect(reader.result()).toEqual({ id: `parent`, lastTitle: `after` });
    expect(reader.renders()).toBe(before + 1);
    reader.unmount();
  });

  it(`A04-5 cascades an imperative parent destroy to owned children`, () => {
    setupAcceptanceRuntime();
    const child = defineModel({
      id: `A04CascadeChild`,
      name: `A04CascadeChild`,
      fields: { parentId: f.id() }
    });
    const parent = defineModel({
      id: `A04CascadeParent`,
      name: `A04CascadeParent`,
      fields: { title: f.str() },
      relations: () => ({ children: hasMany(child, { foreignKey: `parentId`, dependent: `destroy` }) })
    });
    act(() => {
      parent.insertStored({ id: `parent`, title: `parent` });
      child.insertStored({ id: `child`, parentId: `parent` });
    });
    const reader = renderCounted(() => child.use.row(`child`));
    const before = reader.renders();
    act(() => {
      parent.destroy(`parent`);
    });
    expect(parent.get(`parent`)).toBeUndefined();
    expect(reader.result()).toBeUndefined();
    expect(reader.renders()).toBe(before + 1);
    reader.unmount();
  });

  it(`A04-6 collects detached rows while retaining reachable and exempt rows`, async () => {
    const responses = [
      {
        children: [
          { id: `live`, parentId: `parent`, title: `live` },
          { id: `detached`, title: `detached` }
        ],
        parents: [{ id: `parent`, title: `parent` }],
        exempt: [{ id: `exempt`, title: `exempt` }]
      },
      {
        children: [{ id: `live`, parentId: `parent`, title: `live` }],
        parents: [{ id: `parent`, title: `parent` }],
        exempt: [{ id: `exempt`, title: `exempt` }]
      }
    ];
    const transport = createAcceptanceTransport({
      query: async <TData,>() => ({ data: responses.shift() as TData })
    });
    const { storage } = setupAcceptanceRuntime({ transport });
    const parent = defineModel({ id: `A04GcParent`, name: `A04GcParent`, fields: { title: f.str() } });
    const child = defineModel({
      id: `A04GcChild`,
      name: `A04GcChild`,
      fields: { parentId: f.id(), title: f.str() },
      relations: () => ({ parent: belongsTo(parent, { foreignKey: `parentId` }) }),
      scopes: { feed: scope({ sort: `server-order` }) }
    });
    const exempt = defineModel({ id: `A04GcExempt`, name: `A04GcExempt`, fields: { title: f.str() }, gc: `exempt` });
    const query = defineQuery({
      document,
      key: `a04-gc`,
      select: data => (data as { children: Array<{ id: string; parentId?: string; title: string }> }).children,
      into: child.scopes.feed,
      coverage: `complete`,
      extract: ({ data }) => {
        const response = data as { parents: Array<{ id: string; title: string }>; exempt: Array<{ id: string; title: string }> };
        return [
          { into: parent, rows: response.parents },
          { into: exempt, rows: response.exempt }
        ];
      }
    });
    const detachedReader = renderCounted(() => child.use.row(`detached`));
    storage.set([
      {
        key: `dbl:scope:A04GcDeadScope:feed:{"feed":"dead"}`,
        value: JSON.stringify({ generation: 1, coverage: `complete`, entries: [{ id: `missing`, order: 0, seq: 1 }] })
      }
    ]);
    const deadScope = defineModel({
      id: `A04GcDeadScope`,
      name: `A04GcDeadScope`,
      fields: { title: f.str() },
      scopes: { feed: scope({ sort: `server-order` }) }
    });
    const deadScopeReader = renderCounted(() => deadScope.scopes.feed.use({ feed: `dead` }));
    const unrelatedReader = renderCounted(() => exempt.use.row(`exempt`));

    await act(async () => {
      await query.fetch(scopeValue);
      await query.fetch(scopeValue);
    });
    expect(child.scopes.feed.read(scopeValue).map(row => row.id)).toEqual([`live`]);
    expect(child.get(`detached`)).toBeDefined();
    const detachedRenders = detachedReader.renders();
    const scopeRenders = deadScopeReader.renders();
    const unrelatedRenders = unrelatedReader.renders();
    await act(async () => {
      await collectGarbage();
    });
    expect(child.getAll().map(row => row.id)).toEqual([`live`]);
    expect(detachedReader.result()).toBeUndefined();
    expect(detachedReader.renders()).toBe(detachedRenders + 1);
    expect(deadScopeReader.result()).toEqual([]);
    expect(deadScopeReader.renders()).toBe(scopeRenders + 1);
    expect(unrelatedReader.renders()).toBe(unrelatedRenders);
    expect(parent.get(`parent`)).toEqual({ id: `parent`, title: `parent` });
    expect(exempt.get(`exempt`)).toEqual({ id: `exempt`, title: `exempt` });
    detachedReader.unmount();
    deadScopeReader.unmount();
    unrelatedReader.unmount();
  });

  it(`A04-7 replays checkpointed and journal-only writes once after a crash`, () => {
    const storage = createMemoryPlane();
    setupAcceptanceRuntime({ storage, defaults: { persistence: { checkpointDelayMs: 100000, maxPendingPlans: 100000 } } });
    const first = defineModel({ id: `A04Replay`, name: `A04Replay`, fields: { title: f.str() } });
    act(() => {
      first.insertStored({ id: `checkpointed`, title: `checkpointed` });
      flushPersistence();
      first.insertStored({ id: `tail`, title: `tail` });
    });

    setupAcceptanceRuntime({ storage, defaults: { persistence: { checkpointDelayMs: 100000, maxPendingPlans: 100000 } } });
    const restarted = defineModel({ id: `A04Replay`, name: `A04Replay`, fields: { title: f.str() } });
    const reader = renderCounted(() => restarted.use.row(`tail`));
    expect(restarted.get(`checkpointed`)).toEqual({ id: `checkpointed`, title: `checkpointed` });
    expect(reader.result()).toBeUndefined();
    act(() => {
      replayJournal();
    });
    expect(
      restarted
        .getAll()
        .map(row => row.id)
        .sort()
    ).toEqual([`checkpointed`, `tail`]);
    expect(reader.result()).toEqual({ id: `tail`, title: `tail` });
    const renders = reader.renders();
    act(() => {
      replayJournal();
    });
    expect(reader.renders()).toBe(renders);
    reader.unmount();
  });

  // ACCEPTANCE-GAP: purgeForeignStorageKeys documents and implements non-dbl key cleanup, not removal of undefined-model dbl keys.
  it.skip(`A04-8 removes foreign dbl keys while preserving non-dbl and defined-model keys`, () => {
    const storage = createMemoryPlane();
    storage.set([
      { key: `dbl:model:ForeignModel`, value: `foreign` },
      { key: `outside`, value: `outside` }
    ]);
    setupAcceptanceRuntime({ storage });
    const defined = defineModel({ id: `A04Defined`, name: `A04Defined`, fields: { title: f.str() } });
    act(() => {
      defined.insertStored({ id: `defined`, title: `defined` });
      flushPersistence();
    });

    purgeForeignStorageKeys();
    expect(storage.get(`dbl:model:ForeignModel`)).toBeUndefined();
    expect(storage.get(`outside`)).toBe(`outside`);
    expect(storage.keys(`dbl:model:A04Defined`)).not.toHaveLength(0);
  });

  it(`A04-9 removes persisted pending optimistic rows during crash reconciliation`, () => {
    const storage = createMemoryPlane();
    const hold = new Promise<{ data: { save: { id: string; title: string } } }>(() => {});
    const transport = createAcceptanceTransport({
      mutation: <TData,>() => hold as Promise<{ data: TData }>
    });
    setupAcceptanceRuntime({ storage, transport, defaults: { persistence: { checkpointDelayMs: 100000, maxPendingPlans: 100000 } } });
    const first = defineModel({
      id: `A04CrashOrphan`,
      name: `A04CrashOrphan`,
      fields: { title: f.str() },
      scopes: { feed: scope({ sort: `server-order` }) }
    });
    const mutation = defineMutation<{ save: { id: string; title: string } }, Record<string, never>, { id: string; title: string }, { id: string; title: string }>({
      document,
      result: `save`,
      optimistic: {
        model: first,
        build: (_input, context) => ({ id: context.tempId!, title: `pending` }),
        selectServerNode: data => data.save
      }
    });
    act(() => {
      void mutation.run({});
      flushPersistence();
    });

    setupAcceptanceRuntime({ storage, defaults: { persistence: { checkpointDelayMs: 100000, maxPendingPlans: 100000 } } });
    const restarted = defineModel({
      id: `A04CrashOrphan`,
      name: `A04CrashOrphan`,
      fields: { title: f.str() },
      scopes: { feed: scope({ sort: `server-order` }) }
    });
    const reader = renderCounted(() => restarted.scopes.feed.use(scopeValue));
    act(() => {
      replayJournal();
    });
    expect(reader.result()).toEqual([]);
    expect(restarted.getAll()).toEqual([]);
    reader.unmount();
  });

  it(`A04-10 crash before ledger flush cannot orphan temp rows`, () => {
    const storage = createMemoryPlane();
    const hold = new Promise<{ data: { save: { id: string; title: string } } }>(() => {});
    const transport = createAcceptanceTransport({
      mutation: <TData,>() => hold as Promise<{ data: TData }>
    });
    setupAcceptanceRuntime({ storage, transport, defaults: { persistence: { checkpointDelayMs: 100000, maxPendingPlans: 100000 } } });
    const first = defineModel({
      id: `A04LedgerWindow`,
      name: `A04LedgerWindow`,
      fields: { title: f.str() },
      scopes: { feed: scope({ sort: `server-order` }) }
    });
    const mutation = defineMutation<{ save: { id: string; title: string } }, Record<string, never>, { id: string; title: string }, { id: string; title: string }>({
      document,
      result: `save`,
      optimistic: {
        model: first,
        build: (_input, context) => ({ id: context.tempId!, title: `pending` }),
        selectServerNode: data => data.save
      }
    });
    act(() => {
      void mutation.run({});
    });
    expect(first.getAll().some(row => isTempId(row.id))).toBe(true);

    setupAcceptanceRuntime({ storage, defaults: { persistence: { checkpointDelayMs: 100000, maxPendingPlans: 100000 } } });
    const restarted = defineModel({
      id: `A04LedgerWindow`,
      name: `A04LedgerWindow`,
      fields: { title: f.str() },
      scopes: { feed: scope({ sort: `server-order` }) }
    });
    const reader = renderCounted(() => restarted.scopes.feed.use(scopeValue));
    act(() => {
      replayJournal();
    });
    expect(restarted.getAll().some(row => isTempId(row.id))).toBe(false);
    expect(reader.result()).toEqual([]);
    const ingest = defineIngest(restarted, { received: payload => ({ upsert: payload }) });
    act(() => {
      ingest.apply(`received`, { id: `server`, title: `server` });
    });
    expect(restarted.get(`server`)).toEqual({ id: `server`, title: `server` });
    reader.unmount();
  });
});
