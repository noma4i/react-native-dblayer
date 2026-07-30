import {
  defineModel,
  f,
  isNonArrayRecord,
  isNonEmptyString,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  isRecord,
  readBoolean,
  readId,
  readIsoDate,
  readNullableNumber,
  readNullableString,
  readNumber,
  readNumericLike,
  readString,
  stringifyNullish,
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
});

describe('normalization helpers', () => {
  it('normalizes every supported timestamp input and rejects missing input', () => {
    const date = new Date('2026-01-02T03:04:05.000Z');
    expect(toTimestamp(date)).toBe(date.getTime());
    expect(toTimestamp(123)).toBe(123);
    expect(toTimestamp('2026-01-02T03:04:05.000Z')).toBe(date.getTime());
    expect(toTimestamp(undefined)).toBeNaN();
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
    expect(isPositiveSafeInteger(1)).toBe(true);
    expect(isPositiveSafeInteger(0)).toBe(false);
  });

  it('reads scalar values without coercing malformed inputs', () => {
    expect(stringifyNullish(5)).toBe('5');
    expect(stringifyNullish(null)).toBeNull();
    expect(stringifyNullish(undefined)).toBeUndefined();
    expect(readString('value')).toBe('value');
    expect(readString(1)).toBeUndefined();
    expect(readNullableString(null)).toBeNull();
    expect(readNullableString(false)).toBeUndefined();
    expect(readNumber(-0)).toBe(0);
    expect(readNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(readNullableNumber(null)).toBeNull();
    expect(readNullableNumber('1')).toBeUndefined();
    expect(readBoolean(false)).toBe(false);
    expect(readBoolean(0)).toBeUndefined();
  });

  it('reads finite numbers and numeric strings while rejecting blank and malformed values', () => {
    expect(readNumericLike(2)).toBe(2);
    expect(readNumericLike(Number.NaN)).toBeUndefined();
    expect(readNumericLike(' 2.5 ')).toBe(2.5);
    expect(readNumericLike('')).toBeUndefined();
    expect(readNumericLike('   ')).toBeUndefined();
    expect(readNumericLike('nope')).toBeUndefined();
    expect(readNumericLike(null)).toBeUndefined();
  });

  it('reads ISO dates and ids across every accepted input kind', () => {
    const iso = '2026-01-02T03:04:05.000Z';
    const date = new Date(iso);
    expect(readIsoDate(iso)).toBe(iso);
    expect(readIsoDate('invalid')).toBeUndefined();
    expect(readIsoDate(date)).toBe(iso);
    expect(readIsoDate(new Date(Number.NaN))).toBeUndefined();
    expect(readIsoDate(date.getTime())).toBe(iso);
    expect(readIsoDate(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(readIsoDate(null)).toBeUndefined();
    expect(readId('id')).toBe('id');
    expect(readId(7)).toBe('7');
    expect(readId('')).toBeUndefined();
    expect(readId(false)).toBeUndefined();
  });
});
