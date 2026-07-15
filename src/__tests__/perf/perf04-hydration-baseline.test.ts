import { flushPersistence, replayJournal, configureDb } from '../../dsl/configure';
import { defineModel } from '../../dsl/defineModel';
import { scope } from '../../dsl/scope';
import { f } from '../../schema/f';
import { createMemoryStorage, type MemoryStorage } from '../helpers/memoryStorage';
import { mulberry32, storageByteSize } from '../invariants/session.helpers';

type HydrationRow = { id: string; bucket: string; rank: number; payload: string };

const RUNS = 7;
const SIZES = [1_000, 5_000, 20_000] as const;
const SCOPE_COUNTS = [20, 100] as const;

const medianMs = (run: () => void): number => {
  const samples = Array.from({ length: RUNS }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  }).sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)]!;
};

const defineHydrationModel = (id: string) =>
  defineModel({
    id,
    name: `PerfHydrationModel:${id}`,
    fields: { bucket: f.str(), rank: f.num(), payload: f.str() },
    scopes: { pages: scope({ by: { bucket: 'bucket' }, sort: 'server-order' }) }
  });

const rowsFor = (count: number, scopeCount: number): HydrationRow[] => {
  const random = mulberry32(count * 1_000 + scopeCount);
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${index}`,
    bucket: `scope-${index % scopeCount}`,
    rank: Math.floor(random() * 1_000_000),
    payload: `payload-${Math.floor(random() * 1_000_000_000).toString(36)}`
  }));
};

const configure = (storage: MemoryStorage): void => {
  configureDb({
    storage: storage.storage,
    transport: { query: async () => ({ data: {} }), mutation: async () => ({ data: {} }) } as any,
    defaults: { persistence: { checkpointDelayMs: 60_000, maxPendingPlans: 100_000 } }
  });
};

const populateStorage = (rowCount: number, scopeCount: number): { storage: MemoryStorage; id: string; bytes: number } => {
  const storage = createMemoryStorage();
  const id = `perf-hydration-${rowCount}-${scopeCount}`;
  const rows = rowsFor(rowCount, scopeCount);
  configure(storage);
  const model = defineHydrationModel(id);
  for (let scopeIndex = 0; scopeIndex < scopeCount; scopeIndex += 1) {
    const bucket = `scope-${scopeIndex}`;
    model.scopes.pages.__apply?.({ bucket }, rows.filter(row => row.bucket === bucket), 'complete');
  }
  flushPersistence();
  return { storage, id, bytes: storageByteSize(storage.storage) };
};

describe('perf 04: boot hydration baseline', () => {
  it.each(SIZES.flatMap(rowCount => SCOPE_COUNTS.map(scopeCount => [rowCount, scopeCount] as const)))('hydrates %i rows across %i scopes', (rowCount, scopeCount) => {
    const fixture = populateStorage(rowCount, scopeCount);
    const elapsed = medianMs(() => {
      configure(fixture.storage);
      defineHydrationModel(fixture.id);
      replayJournal();
    });
    const parsePerRowUs = elapsed * 1_000 / rowCount;

    console.info(`perf P2 rows=${rowCount} scopes=${scopeCount} median=${elapsed.toFixed(3)}ms parse=${parsePerRowUs.toFixed(3)}us bytes=${fixture.bytes}`);
    expect(elapsed).toBeLessThan(10_000);
  });
});
