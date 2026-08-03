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
