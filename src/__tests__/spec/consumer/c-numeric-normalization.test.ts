import { defineModel, f } from '../../../index';
import { setupSpecRuntime } from '../helpers/harness';

describe('numeric field normalization', () => {
  it('drops non-finite numbers and canonicalizes negative zero', () => {
    setupSpecRuntime();
    const rows = defineModel({
      id: 'SpecNumericNormalization',
      name: 'SpecNumericNormalization',
      fields: { value: f.num(), nullableValue: f.num().nullable() }
    });

    expect(rows.normalize({ id: 'nan', value: Number.NaN, nullableValue: Number.NaN })).toEqual({ id: 'nan' });
    expect(rows.normalize({ id: 'infinity', value: Number.POSITIVE_INFINITY, nullableValue: Number.NEGATIVE_INFINITY })).toEqual({ id: 'infinity' });
    expect(rows.normalize({ id: 'zero', value: -0, nullableValue: -0 })).toEqual({ id: 'zero', value: 0, nullableValue: 0 });
    expect(rows.normalize({ id: 'null', value: 1, nullableValue: null })).toEqual({ id: 'null', value: 1, nullableValue: null });
  });
});
