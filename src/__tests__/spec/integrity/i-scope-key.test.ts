import { buildScopeKey, isWhereOperatorValue, matchesDbWhere } from '../../testApi';

/**
 * Scope-key and where-leaf primitive contracts (mutation-audit survivors): one filter always maps
 * to one stored key, operator records are detected exactly, and ordered comparisons never match
 * across incomparable types.
 */
describe('buildScopeKey stability', () => {
  it('collapses nullish and effectively-empty filters into the single root key', () => {
    const root = buildScopeKey(null);
    expect(buildScopeKey(undefined)).toBe(root);
    expect(buildScopeKey({})).toBe(root);
    expect(buildScopeKey({ chatId: undefined })).toBe(root);
  });

  it('[ID10] keys primitive scopes distinctly from records and from each other', () => {
    const outputs = [buildScopeKey('abc'), buildScopeKey(42), buildScopeKey(true), buildScopeKey({ id: 'abc' }), buildScopeKey(null)];
    expect(new Set(outputs).size).toBe(5);
  });

  it('[R7] produces one key regardless of filter key order and undefined padding', () => {
    expect([buildScopeKey({ a: 1, b: 2 }), buildScopeKey({ b: 2, a: 1 }), buildScopeKey({ b: 2, a: 1, c: undefined })]).toEqual([
      '{"a":1,"b":2}',
      '{"a":1,"b":2}',
      '{"a":1,"b":2}'
    ]);
    expect([buildScopeKey({ a: 1 }), buildScopeKey({ a: '1' })]).toEqual(['{"a":1}', '{"a":"1"}']);
  });
});

describe('operator record detection', () => {
  it('rejects empty records and records with any non-operator key', () => {
    expect(isWhereOperatorValue({})).toBe(false);
    expect(isWhereOperatorValue({ gt: 1, custom: 2 })).toBe(false);
    expect(isWhereOperatorValue({ gt: 1, lte: 5 })).toBe(true);
    expect(isWhereOperatorValue([1])).toBe(false);
  });
});

describe('ordered comparison type safety', () => {
  it('accepts a missing filter and ignores undefined leaf values', () => {
    expect(matchesDbWhere({ v: 5 }, undefined)).toBe(true);
    expect(matchesDbWhere({ v: 5 }, { v: undefined })).toBe(true);
  });

  it('treats non-record filters as non-matching leaf conditions', () => {
    expect(matchesDbWhere({ v: 5 }, 'invalid' as never)).toBe(false);
  });

  it('never matches ordered operators across incomparable or NaN operands', () => {
    expect(matchesDbWhere({ v: 5 }, { v: { gt: '1' } } as never)).toBe(false);
    expect(matchesDbWhere({ v: 'b' }, { v: { gt: 1 } } as never)).toBe(false);
    expect(matchesDbWhere({ v: NaN }, { v: { gte: 0 } } as never)).toBe(false);
    expect(matchesDbWhere({ v: null }, { v: { lt: 5 } } as never)).toBe(false);
  });

  it('orders strings by codepoints for gt/lt operators', () => {
    expect(matchesDbWhere({ v: 'b' }, { v: { gt: 'a' } } as never)).toBe(true);
    expect(matchesDbWhere({ v: 'B' }, { v: { gt: 'a' } } as never)).toBe(false);
  });
});
