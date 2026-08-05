import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { configureDb, defineModel, defineModelRuntime, defineShape, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type Row = { id: string; value: string };

const RowSchema = defineShape<Row>()({ value: f.str() });

describe('model reactive edge contracts', () => {
  it('exposes normalized owner builds to declarations and rejects primitive rows', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    let built: Row | undefined;
    const Rows = defineModel('SpecModelReactiveOwnerBuild', {
      schema: RowSchema,
      relations: owner => {
        built = owner.build({ id: 'built-1', value: 'built' });
        return {};
      }
    });

    expect(built).toEqual({ id: 'built-1', value: 'built' });
    expect(() => Rows.build('invalid' as never)).toThrow('requires id');
  });

  it('keeps the facade hook order stable across null-scope flips and data arrival', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const Rows = defineModelRuntime({
      id: 'SpecModelReactiveHookOrder',
      name: 'SpecModelReactiveHookOrder',
      fields: { value: f.str(), bucket: f.str() },
      scopes: { byBucket: { by: { bucket: 'bucket' } } }
    });
    let renders = 0;
    // Every facade read hook in one component: a conditional hook anywhere below would make
    // React throw "Rendered more/fewer hooks than during the previous render" on any flip.
    const Reader = ({ phase }: { phase: number }) => {
      renders += 1;
      Rows.scopes.byBucket.use(phase % 2 === 0 ? null : { bucket: 'a' });
      Rows.scopes.byBucket.useCount(phase % 2 === 0 ? null : { bucket: 'a' });
      Rows.use.find(phase % 2 === 0 ? 'row-1' : 'missing');
      Rows.use.first(phase % 2 === 0 ? { value: 'seed' } : { value: 'other' });
      Rows.use.failed(phase % 2 === 0 ? 'row-1' : 'missing');
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(Reader, { phase: 0 }));
    });
    for (let phase = 1; phase <= 4; phase += 1) {
      act(() => {
        if (phase === 2) Rows.insert({ id: 'row-1', value: 'seed', bucket: 'a' });
        root.update(React.createElement(Reader, { phase }));
      });
    }
    expect(renders).toBeGreaterThanOrEqual(5);
    act(() => root.unmount());
  });

  it('returns false failed state and undefined for an empty first read', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const Rows = defineModelRuntime({
      id: 'SpecModelReactiveEmpty',
      name: 'SpecModelReactiveEmpty',
      fields: { value: f.str() }
    });
    const failed = renderCounted(() => Rows.use.failed('missing'));
    const first = renderCounted(() => Rows.use.first({ value: 'missing' }));

    expect(failed.result()).toBe(false);
    expect(first.result()).toBeUndefined();
    failed.unmount();
    first.unmount();
  });
});
