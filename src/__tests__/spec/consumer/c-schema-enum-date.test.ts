import { defineModel, defineShape, f, readShape } from '../../legacyTestApi';
import { setupSpecRuntime } from '../helpers/harness';

// Runtime contracts for the enum and date field readers.

describe('f.enum runtime validation', () => {
  const statusShape = defineShape<{ status: string }>()({ status: f.enum(['draft', 'sent'] as const) });

  it('keeps declared values and drops anything else', () => {
    expect(readShape(statusShape, { status: 'draft' })).toEqual({ status: 'draft' });
    expect(readShape(statusShape, { status: 'bogus' })).toEqual({});
    expect(readShape(statusShape, { status: 7 })).toEqual({});
  });

  it('drops invalid enum values at the model normalize boundary', () => {
    setupSpecRuntime();
    const items = defineModel({
      id: 'SpecEnumModelBoundary',
      name: 'SpecEnumModelBoundary',
      fields: { id: f.str(), status: f.enum(['draft', 'sent'] as const) }
    });
    expect(items.build({ id: '1', status: 'bogus' })).toEqual({ id: '1' });
    expect(items.build({ id: '2', status: 'sent' })).toEqual({ id: '2', status: 'sent' });
  });
});

describe('f.date', () => {
  const stampShape = defineShape<{ at: unknown }>()({ at: f.date() });

  it('keeps parseable ISO strings as-is', () => {
    expect(readShape(stampShape, { at: '2026-07-21T00:00:00Z' })).toEqual({ at: '2026-07-21T00:00:00Z' });
  });

  it('converts Date instances and epoch millis to ISO strings', () => {
    expect(readShape(stampShape, { at: new Date(Date.UTC(2026, 6, 21)) })).toEqual({ at: '2026-07-21T00:00:00.000Z' });
    expect(readShape(stampShape, { at: Date.UTC(2026, 6, 21) })).toEqual({ at: '2026-07-21T00:00:00.000Z' });
  });

  it('drops unparseable values', () => {
    expect(readShape(stampShape, { at: 'not-a-date' })).toEqual({});
    expect(readShape(stampShape, { at: new Date('invalid') })).toEqual({});
  });
});

describe('field spec chains', () => {
  it('composes nullable and optional modes without losing explicit null', () => {
    const optionalNullable = f.str().optional().nullable();
    const nullableOptional = f.str().nullable().optional();

    expect(optionalNullable.mode).toBe('optionalNullable');
    expect(nullableOptional.mode).toBe('optionalNullable');
    expect(optionalNullable.read({ value: null }, 'value')).toBeNull();
    expect(nullableOptional.read({ value: 'kept' }, 'value')).toBe('kept');
    expect(f.date().nullable().read({ value: null }, 'value')).toBeNull();
    expect(f.date().nullable().read({ value: '2026-07-21T00:00:00Z' }, 'value')).toBe('2026-07-21T00:00:00Z');
    expect(f.num().read({ value: 2 }, 'value')).toBe(2);
    expect(f.str().optional().mode).toBe('optional');
    expect(f.str().nullable().mode).toBe('nullable');
  });

  it('supports null defaults, factory defaults, selectors, and own-key selectors', () => {
    const nullDefault = f.str().nullDefault();
    const factoryDefault = f.str().default('fallback');
    const selected = f.str().from<{ alias?: string }>(input => input.alias);
    const ownKey = f.str().fromKey<{ nested?: unknown }>('name', input => input.nested);

    expect(nullDefault.read({}, 'missing')).toBeNull();
    expect(nullDefault.hasDefault).toBe(true);
    expect(factoryDefault.factoryDefault).toBe('fallback');
    expect(f.str().read(null, 'missing')).toBeUndefined();
    expect(f.str().fromKey('name').read({ name: 'direct' }, 'ignored')).toBe('direct');
    expect(selected.read({ alias: 'chosen' }, 'ignored')).toBe('chosen');
    expect(ownKey.read({ nested: { name: 'nested' } }, 'ignored')).toBe('nested');
    expect(ownKey.read({ nested: Object.create({ name: 'inherited' }) }, 'ignored')).toBeUndefined();
    expect(ownKey.read({ nested: null }, 'ignored')).toBeUndefined();
  });

  it('contains selector failures and normalizes object and array fields', () => {
    const child = defineShape()({ name: f.str() });
    const shape = defineShape<{
      child?: unknown;
      children?: unknown;
      names?: unknown;
      computed?: string;
      raw?: unknown;
    }>()({
      child: f.object(child).emptyDefault(),
      children: f.array(child),
      names: f.array(f.str()),
      computed: f.str().from(input => {
        if (input.computed === 'throw') throw new Error('selector failed');
        return input.computed;
      }),
      raw: f.raw<Record<string, unknown>>()
    });

    expect(readShape(shape, {
      child: null,
      children: [{ name: 'one' }, null, { name: 2 }],
      names: ['one', null, 2, 'two'],
      computed: 'throw',
      raw: { nested: true }
    })).toEqual({
      children: [{ name: 'one' }, {}],
      names: ['one', 'two'],
      raw: { nested: true }
    });
    expect(readShape(shape, { children: 'nope', names: 'nope', raw: null })).toEqual({});
  });

  it('covers scalar, custom, and empty-object model normalization', () => {
    setupSpecRuntime();
    const child = defineShape()({ name: f.str().default('child') });
    const Item = defineModel({
      id: 'SpecFieldChainItem',
      name: 'SpecFieldChainItem',
      fields: {
        id: f.id(),
        enabled: f.bool(),
        computed: f.custom<string, { computed: string }>(input => input.computed),
        child: f.object(child).emptyDefault(),
        guarded: f.str().from<{ fail?: boolean }>(input => {
          if (input.fail) throw new Error('selector failed');
          return 'kept';
        })
      }
    });

    expect(Item.build({ id: 7, enabled: true, computed: 'value', fail: true } as never)).toEqual({
      id: '7',
      enabled: true,
      computed: 'value',
      child: {}
    });
    Item.insert({ id: 'item-1', enabled: true, computed: 'value', guarded: 'kept' } as never);
    Item.insert({ id: 'item-2', enabled: true, computed: 'value', guarded: 'ignored', fail: true } as never);
    expect(Item.find('item-1')?.guarded).toBe('kept');
    expect(Item.find('item-2')).toEqual({
      id: 'item-2',
      enabled: true,
      computed: 'value'
    });
  });
});
