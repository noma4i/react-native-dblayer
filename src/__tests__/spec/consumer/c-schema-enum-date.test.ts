import { defineModel, defineShape, f, readShape } from '../../../index';
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
    expect(items.buildStored({ id: '1', status: 'bogus' })).toEqual({ id: '1' });
    expect(items.buildStored({ id: '2', status: 'sent' })).toEqual({ id: '2', status: 'sent' });
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
