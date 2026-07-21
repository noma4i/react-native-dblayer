import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { defineModel, f } from '../../../index';
import { setupSpecRuntime } from '../helpers/harness';

// Sort-path scale gates: the unified read comparator (field order + id tie-break) stays cheap.

const buildModel = (tag: string, size: number, rank: (index: number) => number) => {
  setupSpecRuntime();
  const items = defineModel({
    id: `SpecSortScale${tag}${size}`,
    name: `SpecSortScale${tag}${size}`,
    fields: { id: f.str(), rank: f.num(), name: f.str() }
  });
  items.insertStoredMany(Array.from({ length: size }, (_, index) => ({ id: String(index), rank: rank(index), name: `row-${index}` })));
  return items;
};

const sampleOrderedMount = (size: number, tag: string, rank: (index: number) => number): number => {
  const items = buildModel(tag, size, rank);
  const Reader = () => {
    items.use.where(null).orderBy('rank', 'asc').rows();
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

const samplePatchUnderOrderedReader = (size: number): number => {
  const items = buildModel('Patch', size, index => index % 100);
  const Reader = () => {
    items.use.where(null).orderBy('rank', 'asc').rows();
    return null;
  };
  let root!: TestRenderer.ReactTestRenderer;
  act(() => {
    root = TestRenderer.create(React.createElement(Reader));
  });
  const samples = Array.from({ length: 7 }, (_, index) => {
    const started = performance.now();
    act(() => items.patch('75', { rank: 50 + index }));
    return performance.now() - started;
  }).sort((left, right) => left - right);
  act(() => root.unmount());
  return samples[Math.floor(samples.length / 2)]!;
};

describe('sort scale', () => {
  it('keeps all-tied sort keys within a constant factor of distinct keys', () => {
    const distinct = sampleOrderedMount(20_000, 'Distinct', index => index % 100);
    const tied = sampleOrderedMount(20_000, 'Tied', () => 1);
    expect(tied / Math.max(distinct, 0.01)).toBeLessThan(3);
  });

  it('keeps one-row patch cost sublinear under a mounted ordered reader', () => {
    const small = samplePatchUnderOrderedReader(1_000);
    const large = samplePatchUnderOrderedReader(20_000);
    expect(large / Math.max(small, 0.01)).toBeLessThan(12);
  });
});
