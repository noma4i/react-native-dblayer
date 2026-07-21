import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { defineModel, f, type DbWhere } from '../../../index';
import { setupSpecRuntime } from '../helpers/harness';

type ScaleRow = { id: string; score: number; status: string };

const buildModel = (tag: string, size: number) => {
  setupSpecRuntime();
  const items = defineModel({
    id: `SpecWhereOpScale${tag}${size}`,
    name: `SpecWhereOpScale${tag}${size}`,
    fields: { id: f.str(), score: f.num(), status: f.str() }
  });
  items.insertStoredMany(Array.from({ length: size }, (_, index) => ({ id: String(index), score: index % 100, status: index % 2 === 0 ? 'even' : 'odd' })));
  return items;
};

const sampleMountScan = (size: number, tag: string, where: DbWhere<ScaleRow>): number => {
  const items = buildModel(tag, size);
  const Reader = () => {
    (items.use.where as unknown as (criteria: DbWhere<ScaleRow>) => { rows(): unknown[] })(where).rows();
    return null;
  };
  const samples = Array.from({ length: 7 }, () => {
    const started = performance.now();
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(Reader));
    });
    const elapsed = performance.now() - started;
    act(() => root.unmount());
    return elapsed;
  }).sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)]!;
};

const samplePatchUnderReader = (size: number): number => {
  const items = buildModel('Patch', size);
  const Reader = () => {
    (items.use.where as unknown as (criteria: DbWhere<ScaleRow>) => { rows(): unknown[] })({ score: { gte: 50 } }).rows();
    return null;
  };
  let root!: TestRenderer.ReactTestRenderer;
  act(() => {
    root = TestRenderer.create(React.createElement(Reader));
  });
  const samples = Array.from({ length: 7 }, (_, index) => {
    const started = performance.now();
    act(() => items.patch('75', { score: 55 + index }));
    return performance.now() - started;
  }).sort((left, right) => left - right);
  act(() => root.unmount());
  return samples[Math.floor(samples.length / 2)]!;
};

describe('where operator scale', () => {
  it('keeps operator scans within a constant factor of equality scans', () => {
    const equality = sampleMountScan(20_000, 'Eq', { status: 'even' });
    const operator = sampleMountScan(20_000, 'Op', { score: { gte: 50 } });
    expect(operator / Math.max(equality, 0.01)).toBeLessThan(3);
  });

  it('keeps one-row patch cost sublinear under a mounted operator reader', () => {
    const small = samplePatchUnderReader(1_000);
    const large = samplePatchUnderReader(20_000);
    expect(large / Math.max(small, 0.01)).toBeLessThan(12);
  });
});
