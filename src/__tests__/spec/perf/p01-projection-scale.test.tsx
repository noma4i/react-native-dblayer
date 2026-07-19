import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { defineModel, f } from '../../../index';
import { setupSpecRuntime } from '../helpers/harness';

const samplePatch = (size: number): number => {
  setupSpecRuntime();
  const users = defineModel({ id: `SpecProjectionScale${size}`, name: `SpecProjectionScale${size}`, fields: { name: f.str(), ignored: f.num() } });
  users.insertStoredMany(Array.from({ length: size }, (_, index) => ({ id: String(index), name: `User ${index}`, ignored: index })));
  const readRow = users.use.row as unknown as (id: string, options: { select: (row: { name: string }) => { name: string } }) => { name: string };
  const Reader = ({ id }: { id: string }) => {
    readRow(id, { select: row => ({ name: row.name }) });
    return null;
  };
  let root!: TestRenderer.ReactTestRenderer;
  act(() => {
    root = TestRenderer.create(React.createElement(React.Fragment, null, Array.from({ length: 50 }, (_, index) => React.createElement(Reader, { id: String(index), key: index }))));
  });
  const samples = Array.from({ length: 7 }, (_, index) => {
    const started = performance.now();
    act(() => users.patch('25', { ignored: size + index }));
    return performance.now() - started;
  }).sort((left, right) => left - right);
  act(() => root.unmount());
  return samples[Math.floor(samples.length / 2)]!;
};

describe('projection scale', () => {
  it('keeps one-row patch cost sublinear with mounted selectors', () => {
    const small = samplePatch(1_000);
    const large = samplePatch(20_000);
    expect(large / Math.max(small, 0.01)).toBeLessThan(12);
  });
});
