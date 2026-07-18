import { act } from 'react-test-renderer';
import { collectGarbage, defineModel, f, resetRuntime, scope, trimRowsPerScope } from '../../index';
import { createAcceptanceTransport, renderCounted, setupAcceptanceRuntime } from './harness';

const document = { kind: `Document`, definitions: [] } as never;
const scopeValue = { group: `g` };
const makeModels = () => ({
  model: defineModel({
    id: `A07Rows`,
    name: `A07Rows`,
    fields: { group: f.str(), title: f.str(), createdAt: f.num() },
    scopes: { feed: scope({ by: { group: `group` }, sort: `server-order` }) }
  }),
  other: defineModel({ id: `A07Other`, name: `A07Other`, fields: { title: f.str() }, gc: `exempt` })
});
const panel = (model: ReturnType<typeof defineModel>, other: ReturnType<typeof defineModel>) => {
  const readers = {
    row: renderCounted(() => model.use.row(`a`)),
    field: renderCounted(() => model.use.field(`a`, `title`)),
    where: renderCounted(() => model.use.where({ group: `g` }).rows()),
    scope: renderCounted(() => model.scopes.feed.use(scopeValue)),
    window: renderCounted(() => model.scopes.feed.useWindow(scopeValue, { pageSize: 2 })),
    count: renderCounted(() => model.scopes.feed.useCount(scopeValue)),
    other: renderCounted(() => other.use.row(`other`))
  };
  const reset = () => Object.values(readers).map(reader => reader.renders());
  const counts = (before: number[]) => Object.values(readers).map((reader, index) => reader.renders() - before[index]!);
  const close = () => Object.values(readers).forEach(reader => reader.unmount());
  return { reset, counts, close };
};
const log = (name: string, counts: number[]) => console.log(`A07-RESULT ${name}: ${counts.join(`,`)}`);

describe(`A07 reactivity sweep`, () => {
  it(`F-1 query page apply`, async () => {
    const transport = createAcceptanceTransport({
      query: async <TData,>() => ({
        data: {
          rows: [
            { id: `a`, group: `g`, title: `a`, createdAt: 1 },
            { id: `b`, group: `g`, title: `b`, createdAt: 2 }
          ]
        } as TData
      })
    });
    setupAcceptanceRuntime({ transport });
    const { model, other } = makeModels();
    other.insertStored({ id: `other`, title: `other` });
    const readers = panel(model, other);
    const query = model.query(`a07`, { document, key: `a07`, select: data => (data as { rows: unknown[] }).rows, into: model.scopes.feed });
    const before = readers.reset();
    await act(async () => {
      await query.fetch(scopeValue);
    });
    const counts = readers.counts(before);
    log(`F-1`, counts);
    expect(counts).toEqual([1, 1, 1, 1, 1, 1, 0]);
    readers.close();
  });
  it(`F-2 complete refetch detaches`, async () => {
    setupAcceptanceRuntime();
    const { model, other } = makeModels();
    model.insertStored({ id: `a`, group: `g`, title: `a`, createdAt: 1 });
    model.insertStored({ id: `b`, group: `g`, title: `b`, createdAt: 2 });
    other.insertStored({ id: `other`, title: `other` });
    const readers = panel(model, other);
    const before = readers.reset();
    act(() => {
      model.scopes.feed.__apply!(scopeValue, [{ id: `a`, group: `g`, title: `a`, createdAt: 1 }], `complete`);
    });
    const counts = readers.counts(before);
    log(`F-2`, counts);
    expect(counts[0]).toBe(0);
    expect(counts[6]).toBe(0);
    readers.close();
  });
  it(`F-3 ingest idempotence`, () => {
    setupAcceptanceRuntime();
    const { model, other } = makeModels();
    model.insertStored({ id: `a`, group: `g`, title: `a`, createdAt: 1 });
    other.insertStored({ id: `other`, title: `other` });
    const readers = panel(model, other);
    const ingest = model.ingest({ row: { handler: payload => ({ upsert: payload }) } });
    act(() => {
      ingest.apply(`row`, { id: `b`, group: `g`, title: `b`, createdAt: 2 });
    });
    const before = readers.reset();
    act(() => {
      ingest.apply(`row`, { id: `b`, group: `g`, title: `b`, createdAt: 2 });
    });
    const counts = readers.counts(before);
    log(`F-3`, counts);
    expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0]);
    readers.close();
  });
  it(`F-4 maintenance trim`, () => {
    setupAcceptanceRuntime();
    const { model, other } = makeModels();
    model.insertStored({ id: `a`, group: `g`, title: `a`, createdAt: 1 });
    model.insertStored({ id: `b`, group: `g`, title: `b`, createdAt: 2 });
    other.insertStored({ id: `other`, title: `other` });
    const readers = panel(model, other);
    const before = readers.reset();
    trimRowsPerScope(model, `group`, 1, (left, right) => Number(right.createdAt) - Number(left.createdAt));
    const counts = readers.counts(before);
    log(`F-4`, counts);
    expect(counts[6]).toBe(0);
    readers.close();
  });
  it(`F-5 tombstoned snapshot is silent`, () => {
    setupAcceptanceRuntime();
    const { model, other } = makeModels();
    model.insertStored({ id: `a`, group: `g`, title: `a`, createdAt: 1 });
    other.insertStored({ id: `other`, title: `other` });
    model.destroy(`a`);
    const readers = panel(model, other);
    const before = readers.reset();
    model.__applyRows!([{ id: `a`, group: `g`, title: `stale`, createdAt: 1 }]);
    const counts = readers.counts(before);
    log(`F-5`, counts);
    expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0]);
    readers.close();
  });
  it(`F-6 mutation dedupe skip`, async () => {
    const transport = createAcceptanceTransport({ mutation: async <TData,>() => ({ data: { save: { id: `server`, group: `g`, title: `server`, createdAt: 2 } } as TData }) });
    setupAcceptanceRuntime({ transport });
    const { model, other } = makeModels();
    model.insertStored({ id: `a`, group: `g`, title: `a`, createdAt: 1 });
    other.insertStored({ id: `other`, title: `other` });
    const readers = panel(model, other);
    const mutation = model.mutation<
      { save: { id: string; group: string; title: string; createdAt: number } },
      Record<string, never>,
      { id: string; group: string; title: string; createdAt: number },
      { id: string; group: string; title: string; createdAt: number }
    >(`dedupe`, {
      document,
      result: `save`,
      dedupe: { key: () => `same` },
      optimistic: { model, build: (_input, context) => ({ id: context.tempId!, group: `g`, title: `pending`, createdAt: 2 }), selectServerNode: data => data.save }
    });
    await mutation.run({});
    const before = readers.reset();
    await expect(mutation.run({})).resolves.toBeNull();
    const counts = readers.counts(before);
    console.log(`A07-RESULT 6: ${counts.join(`,`)},transportCalls=${transport.calls.filter(call => call.kind === `mutation`).length}`);
    expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(transport.calls.filter(call => call.kind === `mutation`)).toHaveLength(1);
    readers.close();
  });
  it(`F-7 kill switch reset`, () => {
    setupAcceptanceRuntime();
    const { model, other } = makeModels();
    model.insertStored({ id: `a`, group: `g`, title: `a`, createdAt: 1 });
    other.insertStored({ id: `other`, title: `other` });
    const readers = panel(model, other);
    const before = readers.reset();
    act(() => {
      resetRuntime();
    });
    const counts = readers.counts(before);
    log(`F-7`, counts);
    expect(counts.every(count => count === 1)).toBe(true);
    readers.close();
  });
  it(`F-8 GC retains mounted unscoped row`, () => {
    setupAcceptanceRuntime();
    const { model, other } = makeModels();
    model.insertStored({ id: `a`, title: `a`, createdAt: 1 });
    other.insertStored({ id: `other`, title: `other` });
    const readers = panel(model, other);
    const before = readers.reset();
    act(() => {
      collectGarbage();
    });
    const counts = readers.counts(before);
    log(`F-8`, counts);
    expect(counts[0]).toBe(0);
    expect(counts[6]).toBe(0);
    readers.close();
  });
  it(`keeps scope reader identity stable for unrelated model writes`, () => {
    setupAcceptanceRuntime();
    const { model, other } = makeModels();
    model.insertStored({ id: `a`, group: `g`, title: `a`, createdAt: 1 });
    const reader = renderCounted(() => model.scopes.feed.use(scopeValue));
    const initial = reader.result();
    const before = reader.renders();
    act(() => {
      other.insertStored({ id: `other`, title: `ignored` });
    });
    expect(reader.renders() - before).toBe(0);
    expect(reader.result()).toBe(initial);
    reader.unmount();
  });
  it(`rehydrates mounted scope readers with fresh query-applied rows after reset`, async () => {
    const transport = createAcceptanceTransport({ query: async <TData,>() => ({ data: { rows: [{ id: `fresh`, group: `g`, title: `fresh`, createdAt: 2 }] } as TData }) });
    setupAcceptanceRuntime({ transport });
    const { model } = makeModels();
    model.insertStored({ id: `stale`, group: `g`, title: `stale`, createdAt: 1 });
    const reader = renderCounted(() => model.scopes.feed.use(scopeValue));
    act(() => {
      resetRuntime();
    });
    const query = model.query(`a07-scope-reset`, { document, key: `a07-scope-reset`, select: data => (data as { rows: unknown[] }).rows, into: model.scopes.feed });
    await act(async () => {
      await query.fetch(scopeValue);
    });
    expect(reader.result()).toEqual([{ id: `fresh`, group: `g`, title: `fresh`, createdAt: 2 }]);
    reader.unmount();
  });
  it(`keeps window rows stable for off-window scope patches`, () => {
    setupAcceptanceRuntime();
    const { model } = makeModels();
    model.insertStoredMany([
      { id: `a`, group: `g`, title: `a`, createdAt: 1 },
      { id: `b`, group: `g`, title: `b`, createdAt: 2 }
    ]);
    const reader = renderCounted(() => model.scopes.feed.useWindow(scopeValue, { pageSize: 1 }));
    const initial = reader.result().rows;
    const before = reader.renders();
    act(() => {
      model.patch(`b`, { title: `outside` });
    });
    expect(reader.renders() - before).toBe(0);
    expect(reader.result().rows).toBe(initial);
    reader.unmount();
  });
  it(`rehydrates mounted scope windows with fresh rows after reset`, () => {
    setupAcceptanceRuntime();
    const { model } = makeModels();
    model.insertStored({ id: `stale`, group: `g`, title: `stale`, createdAt: 1 });
    const reader = renderCounted(() => model.scopes.feed.useWindow(scopeValue, { pageSize: 1 }));
    act(() => {
      resetRuntime();
      model.insertStored({ id: `fresh`, group: `g`, title: `fresh`, createdAt: 2 });
    });
    expect(reader.result().rows).toEqual([{ id: `fresh`, group: `g`, title: `fresh`, createdAt: 2 }]);
    reader.unmount();
  });
  it(`rehydrates mounted scope counts with fresh writes after reset`, () => {
    setupAcceptanceRuntime();
    const { model } = makeModels();
    model.insertStored({ id: `stale`, group: `g`, title: `stale`, createdAt: 1 });
    const reader = renderCounted(() => model.scopes.feed.useCount(scopeValue));
    act(() => {
      resetRuntime();
      model.insertStoredMany([
        { id: `fresh-a`, group: `g`, title: `fresh-a`, createdAt: 2 },
        { id: `fresh-b`, group: `g`, title: `fresh-b`, createdAt: 3 }
      ]);
    });
    expect(reader.result()).toBe(2);
    reader.unmount();
  });
  it(`stops scope count renders after unmount`, () => {
    setupAcceptanceRuntime();
    const { model } = makeModels();
    const reader = renderCounted(() => model.scopes.feed.useCount(scopeValue));
    reader.unmount();
    const frozen = reader.renders();
    act(() => {
      model.insertStored({ id: `fresh`, group: `g`, title: `fresh`, createdAt: 1 });
    });
    expect(reader.renders()).toBe(frozen);
  });
});
