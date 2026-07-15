import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { configureDb, flushPersistence } from '../../dsl/configure';
import { defineModel } from '../../dsl/defineModel';
import { f } from '../../schema/f';
import { createMemoryStorage } from '../helpers/memoryStorage';
import { mulberry32 } from '../invariants/session.helpers';

type ReactiveRow = { id: string; kind: string; rank: number; value: number };

const RUNS = 7;
const SIZES = [1_000, 5_000, 20_000] as const;
const SUBSCRIBER_COUNTS = [1, 10, 50] as const;

const medianMs = (run: () => void): number => {
  const samples = Array.from({ length: RUNS }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  }).sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)]!;
};

const configure = (): void => {
  const storage = createMemoryStorage();
  configureDb({
    storage: storage.storage,
    transport: { query: async () => ({ data: {} }), mutation: async () => ({ data: {} }) } as any,
    defaults: { persistence: { checkpointDelayMs: 60_000, maxPendingPlans: 100_000 } }
  });
};

const seedRows = (count: number): ReactiveRow[] => {
  const random = mulberry32(count);
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${index}`,
    kind: index === 0 ? 'unrelated' : index % 2 === 0 ? 'watched' : 'other',
    rank: Math.floor(random() * 1_000_000),
    value: Math.floor(random() * 1_000_000)
  }));
};

describe('perf 05: reactive full-scan baseline', () => {
  it.each(SIZES.flatMap(rowCount => SUBSCRIBER_COUNTS.map(subscriberCount => [rowCount, subscriberCount] as const)))('recomputes %i rows for %i live reader groups', (rowCount, subscriberCount) => {
    configure();
    const model = defineModel({
      id: `perf-reactive-${rowCount}-${subscriberCount}`,
      name: `PerfReactiveModel:${rowCount}:${subscriberCount}`,
      fields: { kind: f.str(), rank: f.num(), value: f.num() }
    });
    model.__applyRows?.(seedRows(rowCount));

    const Reader = () => {
      model.use.where({ kind: 'watched' }, { orderBy: { field: 'rank', direction: 'asc' } });
      model.use.count({ kind: 'watched' });
      model.use.first({ kind: 'watched' }, { orderBy: { field: 'rank', direction: 'asc' } });
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(<>{Array.from({ length: subscriberCount }, (_, index) => <Reader key={index} />)}</>);
    });

    let sequence = 0;
    const elapsed = medianMs(() => {
      sequence += 1;
      act(() => {
        model.patch('row-0', { value: sequence });
      });
    });

    console.info(`perf P4 rows=${rowCount} groups=${subscriberCount} liveReads=${subscriberCount * 3} median=${elapsed.toFixed(3)}ms`);
    expect(elapsed).toBeLessThan(10_000);
    act(() => root.unmount());
    flushPersistence();
  });
});
