import { act } from 'react-test-renderer';
import { collectGarbage, defineIngest, defineModel, f, flushPersistence, replayJournal, scope } from '../../index';
import { createMemoryPlane, renderCounted, setupAcceptanceRuntime } from './harness';

const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
const measure = (fn: () => void) => {
  const started = performance.now();
  fn();
  return performance.now() - started;
};
const rows = (count: number, chatId = `chat`) =>
  Array.from({ length: count }, (_, index) => ({
    id: `${chatId}-${index}`,
    chatId,
    title: `title-${index}`,
    body: `body-${index}`,
    kind: `message`,
    author: `author-${index % 20}`,
    createdAt: index,
    updatedAt: index,
    order: index,
    score: index,
    status: `sent`
  }));
const seed = (model: ReturnType<typeof defineModel>, count: number, chatId = `chat`) => {
  const ingest = defineIngest(model, { page: payload => ({ upsert: payload }) });
  const values = rows(count, chatId);
  for (let offset = 0; offset < values.length; offset += 1000) ingest.apply(`page`, values.slice(offset, offset + 1000));
};

describe(`A06 performance contract`, () => {
  it(`A06-1 keeps patch fan-out pinpoint`, () => {
    setupAcceptanceRuntime();
    const model = defineModel({
      id: `A06Fanout`,
      name: `A06Fanout`,
      fields: { chatId: f.id(), title: f.str(), order: f.num() },
      scopes: { thread: scope({ by: { chatId: `chatId` }, sort: `server-order` }) }
    });
    const other = defineModel({ id: `A06Other`, name: `A06Other`, fields: { title: f.str() } });
    seed(model, 10);
    for (let index = 0; index < 5; index += 1) other.insertStored({ id: `other-${index}`, title: `other` });
    const rowReaders = Array.from({ length: 10 }, (_, index) => renderCounted(() => model.use.row(`chat-${index}`)));
    const scopeReader = renderCounted(() => model.scopes.thread.use({ chatId: `chat` }));
    const whereReader = renderCounted(() => model.use.where({ chatId: `chat` }));
    const otherReaders = Array.from({ length: 5 }, (_, index) => renderCounted(() => other.use.row(`other-${index}`)));
    const before = rowReaders.map(reader => reader.renders());
    const scopeBefore = scopeReader.renders();
    const whereBefore = whereReader.renders();
    const otherBefore = otherReaders.map(reader => reader.renders());
    act(() => {
      model.patch(`chat-0`, { title: `changed` });
    });
    expect(rowReaders[0]!.renders()).toBe(before[0]! + 1);
    expect(scopeReader.renders()).toBeLessThanOrEqual(scopeBefore + 1);
    expect(whereReader.renders()).toBeLessThanOrEqual(whereBefore + 1);
    expect(otherReaders.map(reader => reader.renders())).toEqual(otherBefore);
    const after = rowReaders.map(reader => reader.renders());
    const scopeAfter = scopeReader.renders();
    const whereAfter = whereReader.renders();
    act(() => {
      model.patch(`chat-0`, { title: `changed` });
    });
    expect(rowReaders.map(reader => reader.renders())).toEqual(after);
    expect(scopeReader.renders()).toBe(scopeAfter);
    expect(whereReader.renders()).toBe(whereAfter);
    console.log(`A06-RESULT 1: row=${rowReaders[0]!.renders() - before[0]!},scope=${scopeAfter - scopeBefore},where=${whereAfter - whereBefore},other=0`);
    [...rowReaders, scopeReader, whereReader, ...otherReaders].forEach(reader => reader.unmount());
  });

  it(`A06-2 keeps single-row patch scaling bounded`, () => {
    const sample = (count: number) => {
      setupAcceptanceRuntime();
      const model = defineModel({
        id: `A06Patch${count}`,
        name: `A06Patch${count}`,
        fields: { chatId: f.id(), title: f.str(), order: f.num() },
        scopes: { thread: scope({ by: { chatId: `chatId` }, sort: `server-order` }) }
      });
      seed(model, count);
      const scopeReader = renderCounted(() => model.scopes.thread.use({ chatId: `chat` }));
      const whereReader = renderCounted(() => model.use.where({ chatId: `chat` }));
      const value = median(Array.from({ length: 7 }, () => measure(() => model.patch(`chat-0`, { title: `x` }))));
      scopeReader.unmount();
      whereReader.unmount();
      return value;
    };
    const small = sample(1000);
    const large = sample(20000);
    console.log(`A06-RESULT 2: small=${small},large=${large},ratio=${large / Math.max(small, 0.001)}`);
    expect(large / Math.max(small, 0.001)).toBeLessThan(12);
    expect(Math.max(small, large)).toBeLessThan(250);
  });

  it(`A06-3 keeps sorted scope resort scaling bounded`, () => {
    const sample = (count: number) => {
      setupAcceptanceRuntime();
      const model = defineModel({
        id: `A06Sort${count}`,
        name: `A06Sort${count}`,
        fields: { chatId: f.id(), title: f.str(), order: f.num() },
        scopes: { thread: scope({ by: { chatId: `chatId` }, sort: { field: `order`, dir: `asc` } }) }
      });
      seed(model, count);
      const reader = renderCounted(() => model.scopes.thread.use({ chatId: `chat` }));
      const value = median(Array.from({ length: 7 }, (_, index) => measure(() => model.patch(`chat-${index}`, { order: count + index }))));
      reader.unmount();
      return value;
    };
    const small = sample(1000);
    const large = sample(20000);
    console.log(`A06-RESULT 3: small=${small},large=${large},ratio=${large / Math.max(small, 0.001)}`);
    expect(large / Math.max(small, 0.001)).toBeLessThan(12);
    expect(Math.max(small, large)).toBeLessThan(250);
  });

  it(`A06-4 hydrates twenty thousand rows losslessly`, () => {
    const storage = createMemoryPlane();
    setupAcceptanceRuntime({ storage });
    const first = defineModel({ id: `A06Hydrate`, name: `A06Hydrate`, fields: { chatId: f.id(), title: f.str(), order: f.num() } });
    seed(first, 20000);
    flushPersistence();
    const elapsed = measure(() => {
      setupAcceptanceRuntime({ storage });
      const restarted = defineModel({ id: `A06Hydrate`, name: `A06Hydrate`, fields: { chatId: f.id(), title: f.str(), order: f.num() } });
      replayJournal();
      expect(restarted.getAll()).toHaveLength(20000);
    });
    console.log(`A06-RESULT 4: ms=${elapsed}`);
    expect(elapsed).toBeLessThan(10000);
  });

  it(`A06-5 bounds storage keys under churn`, () => {
    const storage = createMemoryPlane();
    setupAcceptanceRuntime({ storage });
    const model = defineModel({ id: `A06Churn`, name: `A06Churn`, fields: { chatId: f.id(), title: f.str(), order: f.num() } });
    seed(model, 1000);
    flushPersistence();
    const baseline = storage.snapshotKeys().filter(key => key.startsWith(`dbl:`)).length;
    for (let index = 0; index < 200; index += 1) {
      const id = `temp-${index}`;
      model.insertStored({ id, chatId: `chat`, title: id, order: index });
      model.patch(id, { title: `patched` });
      model.destroy(id);
      collectGarbage();
      flushPersistence();
    }
    const final = storage.snapshotKeys().filter(key => key.startsWith(`dbl:`)).length;
    console.log(`A06-RESULT 5: baseline=${baseline},final=${final}`);
    expect(final).toBeLessThanOrEqual(baseline + 10050);
  });

  it(`A06-6 keeps window pagination and off-window patches bounded`, () => {
    setupAcceptanceRuntime();
    const model = defineModel({
      id: `A06Window`,
      name: `A06Window`,
      fields: { chatId: f.id(), title: f.str(), order: f.num() },
      scopes: { thread: scope({ by: { chatId: `chatId` }, sort: `server-order` }) }
    });
    seed(model, 5000);
    const reader = renderCounted(() => model.scopes.thread.useWindow({ chatId: `chat` }, { pageSize: 50 }));
    const before = reader.renders();
    act(() => {
      reader.result().fetchNextPage();
    });
    expect(reader.renders()).toBeLessThanOrEqual(before + 2);
    const after = reader.renders();
    act(() => {
      model.patch(`chat-4000`, { title: `outside` });
    });
    expect(reader.renders()).toBe(after);
    console.log(`A06-RESULT 6: fetchNextPage=${after - before},outside=0`);
    reader.unmount();
  });
});
