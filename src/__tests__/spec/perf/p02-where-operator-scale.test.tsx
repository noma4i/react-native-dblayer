import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { defineModel, f, type DbWhere } from '../../../index';
import { diagnostics, setupSpecRuntime } from '../helpers/harness';

type ScaleRow = { id: string; score: number; status: string };

const buildModel = (tag: string, size: number) => {
  setupSpecRuntime();
  const items = defineModel({
    id: `SpecWhereOpScale${tag}${size}`,
    name: `SpecWhereOpScale${tag}${size}`,
    fields: { id: f.str(), score: f.num(), status: f.str() }
  });
  items.insertMany(Array.from({ length: size }, (_, index) => ({ id: String(index), score: index % 100, status: index % 2 === 0 ? 'even' : 'odd' })));
  return items;
};

const mountScanWork = (where: DbWhere<ScaleRow>) => {
  const items = buildModel('Mount', 20_000);
  const Reader = () => {
    (items.use.where as unknown as (criteria: DbWhere<ScaleRow>) => { rows(): unknown[] })(where).rows();
    return null;
  };
  diagnostics().reset();
  let root!: TestRenderer.ReactTestRenderer;
  act(() => {
    root = TestRenderer.create(React.createElement(Reader));
  });
  const work = diagnostics().snapshot();
  act(() => root.unmount());
  return work;
};

const patchWork = (size: number) => {
  const items = buildModel('Patch', size);
  const Reader = () => {
    (items.use.where as unknown as (criteria: DbWhere<ScaleRow>) => { rows(): unknown[] })({ score: { gte: 50 } }).rows();
    return null;
  };
  let root!: TestRenderer.ReactTestRenderer;
  act(() => {
    root = TestRenderer.create(React.createElement(Reader));
  });
  diagnostics().reset();
  act(() => {
    items.update('75', { score: 56 });
  });
  const work = diagnostics().snapshot();
  act(() => root.unmount());
  return work;
};

describe('where operator scale', () => {
  it('scans the same number of rows for equality and operator criteria', () => {
    const equality = mountScanWork({ status: 'even' });
    const operator = mountScanWork({ score: { gte: 50 } });

    expect(operator.readEngineScanRows).toBe(equality.readEngineScanRows);
  });

  it('keeps one-row patch work constant under a mounted operator reader', () => {
    const small = patchWork(1_000);
    const large = patchWork(20_000);

    expect(large.readEngineApplies).toBe(small.readEngineApplies);
    expect(large.readEngineRebuilds).toBe(small.readEngineRebuilds);
    expect(large.readEngineDeltaRows).toBe(small.readEngineDeltaRows);
    expect(small.readEngineApplies).toBe(1);
    expect(small.readEngineRebuilds).toBe(0);
    expect(small.readEngineDeltaRows).toBe(1);
  });
});
