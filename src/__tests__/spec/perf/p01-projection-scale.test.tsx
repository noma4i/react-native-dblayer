import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { defineModel, f } from '../../../index';
import { diagnostics, setupSpecRuntime } from '../helpers/harness';

const measurePatchWork = (size: number) => {
  setupSpecRuntime();
  const users = defineModel({
    id: `SpecProjectionScale${size}`,
    name: `SpecProjectionScale${size}`,
    fields: { name: f.str(), ignored: f.num() }
  });
  users.insertMany(Array.from({ length: size }, (_, index) => ({ id: String(index), name: `user-${index}`, ignored: 0 })));
  const renders = new Map<string, number>();
  const Reader = ({ id }: { id: string }) => {
    users.use.where({ id }).select(row => ({ name: row.name, ignored: row.ignored })).rows();
    renders.set(id, (renders.get(id) ?? 0) + 1);
    return null;
  };
  let root!: TestRenderer.ReactTestRenderer;
  act(() => {
    root = TestRenderer.create(React.createElement(React.Fragment, null, Array.from({ length: 50 }, (_, index) => React.createElement(Reader, { id: String(index), key: index }))));
  });
  const before = new Map(renders);
  diagnostics().reset();
  act(() => {
    users.update('25', { ignored: 1 });
  });
  const work = diagnostics().snapshot();
  const deltas = Array.from({ length: 50 }, (_, index) => (renders.get(String(index)) ?? 0) - (before.get(String(index)) ?? 0));
  act(() => root.unmount());
  return { work, deltas };
};

describe('projection scale', () => {
  it('keeps one-row patch work constant under 50 mounted selectors', () => {
    const small = measurePatchWork(1_000);
    const large = measurePatchWork(20_000);

    expect(large.work.readEngineApplies).toBe(small.work.readEngineApplies);
    expect(large.work.readEngineRebuilds).toBe(small.work.readEngineRebuilds);
    expect(large.work.readEngineDeltaRows).toBe(small.work.readEngineDeltaRows);
    expect(small.work.readEngineApplies).toBe(50);
    expect(small.work.readEngineRebuilds).toBe(0);
    expect(small.work.readEngineDeltaRows).toBe(50);
    small.deltas.forEach((renders, index) => expect(renders).toBe(index === 25 ? 1 : 0));
    large.deltas.forEach((renders, index) => expect(renders).toBe(index === 25 ? 1 : 0));
  });
});
