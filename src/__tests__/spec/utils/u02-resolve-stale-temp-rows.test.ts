import { resolveStaleTempRows, trimRowsPerScope } from '../../../utils/modelMaintenance';

type Row = { id: string; createdAt: string };

describe('resolveStaleTempRows NaN safety', () => {
  it('treats an unparseable createdAt as maximally stale instead of protecting the row indefinitely', () => {
    const onStale = jest.fn();
    const badRow: Row = { id: 'temp-bad', createdAt: 'not-a-date' };
    const oldRow: Row = { id: 'temp-old', createdAt: new Date(Date.now() - 10_000).toISOString() };
    const model = { all: () => [badRow, oldRow] };

    const resolved = resolveStaleTempRows(model, { maxAgeMs: 1, onStale });

    expect(onStale).toHaveBeenCalledWith(badRow);
    expect(onStale).toHaveBeenCalledWith(oldRow);
    expect(resolved).toBe(2);
  });

  it('still protects a temp row with a valid, recent createdAt', () => {
    const onStale = jest.fn();
    const freshRow: Row = { id: 'temp-fresh', createdAt: new Date().toISOString() };
    const model = { all: () => [freshRow] };

    const resolved = resolveStaleTempRows(model, { maxAgeMs: 60_000, onStale });

    expect(onStale).not.toHaveBeenCalled();
    expect(resolved).toBe(0);
  });
});

describe('model maintenance edges', () => {
  it('trims grouped rows while excluding protected and null-scope rows', () => {
    const destroyed: string[][] = [];
    const rows = [
      { id: 'a-1', scope: 'a', rank: 1 },
      { id: 'a-2', scope: 'a', rank: 2 },
      { id: 'a-protected', scope: 'a', rank: 3 },
      { id: 'without-scope', scope: null, rank: 4 }
    ];
    const model = { all: () => rows, destroyMany: (ids: string[]) => destroyed.push(ids) };

    expect(trimRowsPerScope(model, 'scope', 1, (left, right) => right.rank - left.rank, ['a-protected'])).toBe(1);
    expect(destroyed).toEqual([['a-1']]);
  });

  it('accepts set and predicate protection and skips destruction when no row exceeds the limit', () => {
    const destroyMany = jest.fn();
    const rows = [
      { id: 'a-1', scope: 'a', rank: 1 },
      { id: 'a-2', scope: 'a', rank: 2 }
    ];
    const model = { all: () => rows, destroyMany };

    expect(trimRowsPerScope(model, 'scope', 0, (left, right) => right.rank - left.rank, new Set(['a-1', 'a-2']))).toBe(0);
    expect(trimRowsPerScope(model, 'scope', 0, (left, right) => right.rank - left.rank, () => true)).toBe(0);
    expect(destroyMany).not.toHaveBeenCalled();
  });

  it('does not group a row whose scope value is null', () => {
    const destroyMany = jest.fn();
    const model = { all: () => [{ id: 'without-scope', scope: null, rank: 1 }], destroyMany };

    expect(trimRowsPerScope(model, 'scope', 0, () => 0)).toBe(0);
    expect(destroyMany).not.toHaveBeenCalled();
  });

  it('protects stale temp rows from both array and set inputs', () => {
    const onStale = jest.fn();
    const row: Row = { id: 'temp-protected', createdAt: 'not-a-date' };
    const model = { all: () => [row] };

    expect(resolveStaleTempRows(model, { maxAgeMs: 0, protectedIds: ['temp-protected'], onStale })).toBe(0);
    expect(resolveStaleTempRows(model, { maxAgeMs: 0, protectedIds: new Set(['temp-protected']), onStale })).toBe(0);
    expect(onStale).not.toHaveBeenCalled();
  });
});
