import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { configureDb, flushPersistence } from '../../dsl/configure';
import { defineModel } from '../../dsl/defineModel';
import { f } from '../../schema/f';
import { createMemoryStorage } from '../helpers/memoryStorage';
import { mulberry32 } from '../invariants/session.helpers';

type ReactiveRow = { id: string; kind: string; rank: number; value: number };

const RUNS = 7;
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

const measure = (rowCount: number, subscriberCount: number): number => {
    configure();
    const model = defineModel({
      id: `perf-reactive-${rowCount}-${subscriberCount}`,
      name: `PerfReactiveModel:${rowCount}:${subscriberCount}`,
      fields: { kind: f.str(), rank: f.num(), value: f.num() }
    });
    model.__applyRows?.(seedRows(rowCount));

    const Reader = () => {
      model.use.where({ kind: 'watched' }).orderBy('rank').rows();
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

    act(() => root.unmount());
    flushPersistence();
    return elapsed;
};

describe('perf 05: incremental reactive scaling', () => {
  it.each(SUBSCRIBER_COUNTS)('keeps the 20k-to-1k delta ratio bounded for %i live reader groups', subscriberCount => {
    const small = measure(1_000, subscriberCount);
    const large = measure(20_000, subscriberCount);
    const ratio = large / Math.max(small, 0.1);
    console.info(`perf P4 groups=${subscriberCount} 1k=${small.toFixed(3)}ms 20k=${large.toFixed(3)}ms ratio=${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThan(12);
  });
});
