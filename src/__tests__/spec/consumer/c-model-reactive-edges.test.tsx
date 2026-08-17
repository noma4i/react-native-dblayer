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

  it('keeps the facade hook order stable and its values exact across null-scope flips and data arrival', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const Rows = defineModelRuntime({
      id: 'SpecModelReactiveHookOrder',
      name: 'SpecModelReactiveHookOrder',
      fields: { value: f.str(), bucket: f.str() },
      scopes: { byBucket: { by: { bucket: 'bucket' } } }
    });
    type Observed = { scopeIds: string[]; count: number; findId: string | undefined; firstId: string | undefined; failed: boolean };
    let latest!: Observed;
    // Every facade read hook in one component: a conditional hook anywhere below would make
    // React throw "Rendered more/fewer hooks than during the previous render" on any flip.
    const Reader = ({ phase }: { phase: number }) => {
      const scopeRows = Rows.scopes.byBucket.use(phase % 2 === 0 ? null : { bucket: 'a' });
      const count = Rows.scopes.byBucket.useCount(phase % 2 === 0 ? null : { bucket: 'a' });
      const found = Rows.use.find(phase % 2 === 0 ? 'row-1' : 'missing');
      const first = Rows.use.first(phase % 2 === 0 ? { value: 'seed' } : { value: 'other' });
      const failed = Rows.use.failed(phase % 2 === 0 ? 'row-1' : 'missing');
      latest = { scopeIds: scopeRows.map(row => row.id), count, findId: found?.id, firstId: first?.id, failed };
      return null;
    };
    const seeded = { id: 'row-1', value: 'seed', bucket: 'a' };
    const expectedByPhase: Observed[] = [
      { scopeIds: [], count: 0, findId: undefined, firstId: undefined, failed: false },
      { scopeIds: [], count: 0, findId: undefined, firstId: undefined, failed: false },
      { scopeIds: [], count: 0, findId: 'row-1', firstId: 'row-1', failed: false },
      { scopeIds: ['row-1'], count: 1, findId: undefined, firstId: undefined, failed: false },
      { scopeIds: [], count: 0, findId: 'row-1', firstId: 'row-1', failed: false }
    ];
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(Reader, { phase: 0 }));
    });
    expect(latest).toEqual(expectedByPhase[0]);
    for (let phase = 1; phase <= 4; phase += 1) {
      act(() => {
        if (phase === 2) Rows.insert(seeded);
        root.update(React.createElement(Reader, { phase }));
      });
      expect(latest).toEqual(expectedByPhase[phase]);
    }
    expect(Rows.find('row-1')).toEqual(seeded);
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
