import { fromNodes, intoIf } from '../../../index';

// Pure extract/unwrap helper contracts.

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

describe('intoIf', () => {
  const into = { modelId: 'spec-model' } as never;

  it('returns [] for nullish rows', () => {
    expect(intoIf(into, null)).toEqual([]);
    expect(intoIf(into, undefined)).toEqual([]);
  });

  it('wraps one node into a single sink preserving the destination identity', () => {
    const node = { id: '1' };
    const sinks = intoIf(into, node);
    expect(sinks).toHaveLength(1);
    expect(sinks[0]!.into).toBe(into);
    expect(sinks[0]!.rows).toEqual([node]);
  });
});
