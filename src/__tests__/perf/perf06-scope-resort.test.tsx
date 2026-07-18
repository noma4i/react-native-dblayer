import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { getCommitBus, configureDb, flushPersistence } from '../../dsl/configure';
import { defineModel } from '../../dsl/defineModel';
import { scope } from '../../dsl/scope';
import { f } from '../../schema/f';
import { createMemoryStorage } from '../helpers/memoryStorage';
import { mulberry32 } from '../invariants/session.helpers';

type ScopeRow = { id: string; bucket: string; rank: number; value: number };

const RUNS = 7;
const SIZES = [1_000, 5_000, 20_000] as const;

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

const seedRows = (count: number): ScopeRow[] => {
  const random = mulberry32(count * 17);
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${index}`,
    bucket: 'active',
    rank: Math.floor(random() * 1_000_000),
    value: index
  }));
};

const measureFieldSort = (rowCount: number): { elapsed: number; dependencyCount: number } => {
    configure();
    const model = defineModel({
      id: `perf-scope-${rowCount}`,
      name: `PerfScopeModel:${rowCount}`,
      fields: { bucket: f.str(), rank: f.num(), value: f.num() },
      scopes: { active: scope({ by: { bucket: 'bucket' }, sort: { field: 'rank', dir: 'asc' } }) }
    });
    model.scopes.active.__apply?.({ bucket: 'active' }, seedRows(rowCount), 'complete');

    const bus = getCommitBus();
    const subscribe = jest.spyOn(bus, 'subscribeIncremental');
    const Reader = () => {
      model.scopes.active.use({ bucket: 'active' });
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(<Reader />);
    });
    const dependencyCount = (subscribe.mock.calls.at(-1)?.[1] ?? []).length;

    let sequence = 0;
    const elapsed = medianMs(() => {
      sequence += 1;
      act(() => {
        model.patch('row-0', { rank: sequence % 2 === 0 ? rowCount + sequence : -sequence });
      });
    });

    console.info(`perf P5 rows=${rowCount} deps=${dependencyCount} median=${elapsed.toFixed(3)}ms`);
    act(() => root.unmount());
    subscribe.mockRestore();
    flushPersistence();
    return { elapsed, dependencyCount };
};

describe('perf 06: incremental scope resort scaling', () => {
  it.each(SIZES)('installs exactly one dependency for a %i-member field-sorted scope', rowCount => {
    const result = measureFieldSort(rowCount);
    expect(result.dependencyCount).toBe(1);
  });

  it('keeps field-sort scaling separate from comparator fallback behavior', () => {
    const small = measureFieldSort(1_000).elapsed;
    const large = measureFieldSort(20_000).elapsed;
    const ratio = large / Math.max(small, 0.1);
    console.info(`perf P5 field-sort 1k=${small.toFixed(3)}ms 20k=${large.toFixed(3)}ms ratio=${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThan(40);
  });
});
