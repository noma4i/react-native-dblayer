import { scalar } from '../../testApi';

describe('scalar transport boundary', () => {
  it('reads every scalar transport representation through the field codecs', () => {
    expect(scalar.str.read('value')).toBe('value');
    expect(scalar.str.read(42)).toBeUndefined();
    expect(scalar.num.read('2.5')).toBe(2.5);
    expect(scalar.int.read('42')).toBe(42);
    expect(scalar.date.read(new Date('2026-07-31T00:00:00.000Z'))).toBe('2026-07-31T00:00:00.000Z');
    expect(scalar.bool.read('false')).toBe(false);
    expect(scalar.id.read(42)).toBe('42');
    expect(scalar.enum(['draft', 'sent'] as const).read('sent')).toBe('sent');
    expect(scalar.enum(['draft', 'sent'] as const).read('unknown')).toBeUndefined();
  });

  it('returns typed required values and rejects unreadable transport values', () => {
    expect(scalar.id.require(42, 'Message id')).toBe('42');
    expect(scalar.int.require('42', 'Message sequence')).toBe(42);
    expect(() => scalar.id.require('', 'Message id')).toThrow('Message id is required');
    expect(() => scalar.int.require('2.5', 'Message sequence')).toThrow('Message sequence must be a safe integer');
  });
});
