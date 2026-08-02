import { fromNodes } from '../../testApi';

// Pure connection helper contracts.

describe('fromNodes', () => {
  it('drops nullish entries and preserves order', () => {
    expect(fromNodes({ nodes: [1, null, 2, undefined, 3] })).toEqual([1, 2, 3]);
  });

  it('returns [] for nullish connections and nullish node lists', () => {
    expect(fromNodes(null)).toEqual([]);
    expect(fromNodes(undefined)).toEqual([]);
    expect(fromNodes({ nodes: null })).toEqual([]);
    expect(fromNodes({})).toEqual([]);
  });
});
