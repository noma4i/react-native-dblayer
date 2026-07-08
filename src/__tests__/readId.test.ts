import { f } from '../schema/f';
import { readId } from '../utils/normalizeHelpers';

describe('readId canon', () => {
  it('passes strings and numbers through as strings', () => {
    expect(readId('abc')).toBe('abc');
    expect(readId('42')).toBe('42');
    expect(readId(42)).toBe('42');
    expect(readId(0)).toBe('0');
  });

  it('rejects non-string/number input instead of stringifying it', () => {
    expect(readId(true)).toBeUndefined();
    expect(readId(false)).toBeUndefined();
    expect(readId({})).toBeUndefined();
    expect(readId({ id: '1' })).toBeUndefined();
    expect(readId(['a', 'b'])).toBeUndefined();
    expect(readId(null)).toBeUndefined();
    expect(readId(undefined)).toBeUndefined();
  });

  it('keeps f.id() behavior unchanged for legit inputs now that it shares the canon reader', () => {
    const spec = f.id();

    expect(spec.read({ id: 'server-1' }, 'id')).toBe('server-1');
    expect(spec.read({ id: 7 }, 'id')).toBe('7');
    expect(spec.read({ id: true }, 'id')).toBeUndefined();
    expect(spec.read({ id: {} }, 'id')).toBeUndefined();
    expect(spec.read({}, 'id')).toBeUndefined();
  });
});
