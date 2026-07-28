import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { defineModel, f, scope } from '../../../index';
import { diagnostics, setupSpecRuntime } from '../helpers/harness';

type ScaleRow = { id: string; bucket: string; rank: number; name: string };

const comparatorCalls = (size: number, rank: (index: number) => number): number => {
  setupSpecRuntime();
  let calls = 0;
  const items = defineModel({
    id: `SpecSortScale${size}${rank(1)}`,
    name: `SpecSortScale${size}${rank(1)}`,
    fields: { bucket: f.str(), rank: f.num(), name: f.str() },
    scopes: {
      ranked: scope<ScaleRow>({
        by: { bucket: 'bucket' },
        sort: { comparator: (left, right) => {
          calls += 1;
          return left.rank - right.rank;
        } }
      })
    }
  });
  items.insertMany(Array.from({ length: size }, (_, index) => ({ id: String(index), bucket: 'all', rank: rank(index), name: `row-${index}` })));
  calls = 0;
  items.scopes.ranked.read({ bucket: 'all' });
  return calls;
};

const patchWork = (size: number) => {
  setupSpecRuntime();
  const items = defineModel({
    id: `SpecSortPatch${size}`,
    name: `SpecSortPatch${size}`,
    fields: { rank: f.num(), name: f.str() }
  });
  items.insertMany(Array.from({ length: size }, (_, index) => ({ id: String(index), rank: index % 100, name: `row-${index}` })));
  const Reader = ({ id }: { id: string }) => {
    items.use.where({ id }).orderBy('rank', 'asc').select(row => ({ rank: row.rank, name: row.name })).rows();
    return null;
  };
  let root!: TestRenderer.ReactTestRenderer;
  act(() => {
    root = TestRenderer.create(React.createElement(React.Fragment, null, Array.from({ length: 50 }, (_, index) => React.createElement(Reader, { id: String(index), key: index }))));
  });
  diagnostics().reset();
  act(() => {
    items.update('25', { rank: 51 });
  });
  const work = diagnostics().snapshot();
  act(() => root.unmount());
  return work;
};

describe('sort scale', () => {
  it('keeps all-tied comparator calls within a constant factor of distinct keys', () => {
    const distinct = comparatorCalls(20_000, index => index);
    const tied = comparatorCalls(20_000, () => 1);

    expect(tied).toBeLessThanOrEqual(distinct * 2);
  });

  it('keeps one-row patch work constant under mounted ordered readers', () => {
    const small = patchWork(1_000);
    const large = patchWork(20_000);

    expect(large.readEngineApplies).toBe(small.readEngineApplies);
    expect(large.readEngineRebuilds).toBe(small.readEngineRebuilds);
    expect(large.readEngineDeltaRows).toBe(small.readEngineDeltaRows);
    expect(small.readEngineApplies).toBe(50);
    expect(small.readEngineRebuilds).toBe(0);
    expect(small.readEngineDeltaRows).toBe(50);
  });
});
