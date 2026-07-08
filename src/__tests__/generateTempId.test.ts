import { createOptimisticSequence, generateTempId, isTempId } from '../index';

describe('generateTempId', () => {
  it('detects generated temp ids and rejects non-temp ids', () => {
    expect(isTempId(generateTempId())).toBe(true);
    expect(isTempId(generateTempId('moment'))).toBe(true);
    expect(isTempId('server-1')).toBe(false);
    expect(isTempId('temp')).toBe(false);
    expect(isTempId('temporary-1')).toBe(false);
  });

  it('handles nullable and edge ids', () => {
    expect(isTempId(undefined)).toBe(false);
    expect(isTempId(null)).toBe(false);
    expect(isTempId('')).toBe(false);
    expect(isTempId('temp-')).toBe(true);
  });

  it('creates independent monotonic optimistic sequences', () => {
    const first = createOptimisticSequence();
    const second = createOptimisticSequence();

    expect([first.next(), first.next(), first.next()]).toEqual([0, 1, 2]);
    expect(second.next()).toBe(0);
    expect(first.next()).toBe(3);
  });
});
