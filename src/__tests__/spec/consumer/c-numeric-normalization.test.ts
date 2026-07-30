import {
  defineModel,
  f,
  isNonArrayRecord,
  isNonEmptyString,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  isRecord,
  toTimestamp
} from '../../legacyTestApi';
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

  it('converts numeric transport strings to stored numbers', () => {
    setupSpecRuntime();
    const rows = defineModel({
      id: 'SpecNumericTransportNormalization',
      name: 'SpecNumericTransportNormalization',
      fields: { value: f.num() }
    });

    expect(rows.normalize({ id: 'decimal', value: '2.5' })).toEqual({ id: 'decimal', value: 2.5 });
    expect(rows.normalize({ id: 'blank', value: '   ' })).toEqual({ id: 'blank' });
  });

  it('converts integer transport values and rejects fractional or unsafe values', () => {
    setupSpecRuntime();
    const rows = defineModel({
      id: 'SpecIntegerTransportNormalization',
      name: 'SpecIntegerTransportNormalization',
      fields: { value: f.int() }
    });

    expect(rows.normalize({ id: 'string', value: '42' })).toEqual({ id: 'string', value: 42 });
    expect(rows.normalize({ id: 'number', value: 42 })).toEqual({ id: 'number', value: 42 });
    expect(rows.normalize({ id: 'fraction', value: '2.5' })).toEqual({ id: 'fraction' });
    expect(rows.normalize({ id: 'unsafe', value: String(Number.MAX_SAFE_INTEGER + 1) })).toEqual({ id: 'unsafe' });
  });
});

describe('normalization helpers', () => {
  it('normalizes every supported timestamp input and rejects missing input', () => {
    const date = new Date('2026-01-02T03:04:05.000Z');
    expect(toTimestamp(date)).toBe(date.getTime());
    expect(toTimestamp(123)).toBe(123);
    expect(toTimestamp('2026-01-02T03:04:05.000Z')).toBe(date.getTime());
    expect(toTimestamp(undefined)).toBeNaN();
    expect(toTimestamp(null as never)).toBeNaN();
  });

  it('classifies records, strings, and safe integers at their boundaries', () => {
    expect(isRecord([])).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isNonArrayRecord({})).toBe(true);
    expect(isNonArrayRecord([])).toBe(false);
    expect(isNonEmptyString('x')).toBe(true);
    expect(isNonEmptyString('')).toBe(false);
    expect(isNonNegativeSafeInteger(0)).toBe(true);
    expect(isNonNegativeSafeInteger(-1)).toBe(false);
    expect(isNonNegativeSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isPositiveSafeInteger(1)).toBe(true);
    expect(isPositiveSafeInteger(0)).toBe(false);
    expect(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

});
