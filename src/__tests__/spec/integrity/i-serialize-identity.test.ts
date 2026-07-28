import { compareCodepoints, compositeKey, semanticValue, stableSerialize } from '../../../core/serialize';

/**
 * Identity backbone contracts: every scope key, dedupe key, and composite key in the runtime is
 * built on these three primitives. The mutation audit showed their branch behavior was untested
 * (37% score) - each `it` below pins one injectivity/stability guarantee a mutant survived on.
 */
describe('compareCodepoints ordering laws', () => {
  it('orders by raw codepoints with antisymmetry and a zero fixpoint for equal strings', () => {
    expect(compareCodepoints('a', 'b')).toBe(-1);
    expect(compareCodepoints('b', 'a')).toBe(1);
    expect(compareCodepoints('a', 'a')).toBe(0);
    expect(compareCodepoints('', 'a')).toBe(-1);
    expect(compareCodepoints('B', 'a')).toBe(-1);
  });
});

describe('stableSerialize injectivity across value branches', () => {
  it('distinguishes null, undefined, and their string spellings', () => {
    const outputs = [stableSerialize(null), stableSerialize(undefined), stableSerialize('null'), stableSerialize('undefined')];
    expect(new Set(outputs).size).toBe(4);
  });

  it('distinguishes numbers, NaN, bigints, booleans, and their string spellings', () => {
    const outputs = [
      stableSerialize(1),
      stableSerialize('1'),
      stableSerialize(1n),
      stableSerialize(NaN),
      stableSerialize('NaN'),
      stableSerialize(true),
      stableSerialize('true')
    ];
    expect(new Set(outputs).size).toBe(7);
  });

  it('never collides a scalar with an exotic object whose toString spells the same text', () => {
    const spelledLikeOne = { toString: () => '1', [Symbol.toStringTag]: 'Weird' };
    Object.setPrototypeOf(spelledLikeOne, class {}.prototype);
    const spelledLikeUndefined = { toString: () => 'undefined' };
    Object.setPrototypeOf(spelledLikeUndefined, class {}.prototype);
    const outputs = [stableSerialize(1), stableSerialize('1'), stableSerialize(1n), stableSerialize(spelledLikeOne), stableSerialize(undefined), stableSerialize(spelledLikeUndefined)];
    expect(new Set(outputs).size).toBe(6);
  });

  it('distinguishes dates, maps, and empty records from each other and from label spellings', () => {
    const outputs = [stableSerialize(new Date(5)), stableSerialize(5), stableSerialize('Date(5)'), stableSerialize({}), stableSerialize(new Map([['a', 1]]))];
    expect(new Set(outputs).size).toBe(5);
  });

  it('distinguishes arrays from scalar-equivalent and object-equivalent shapes', () => {
    const outputs = [stableSerialize([1]), stableSerialize(['1']), stableSerialize(1), stableSerialize({}), stableSerialize([])];
    expect(new Set(outputs).size).toBe(5);
  });

  it('keeps the exact persisted spelling of every branch - stored scope keys must survive updates', () => {
    expect(stableSerialize(null)).toBe('null');
    expect(stableSerialize(undefined)).toBe('undefined');
    expect(stableSerialize(NaN)).toBe('NaN');
    expect(stableSerialize(2)).toBe('2');
    expect(stableSerialize(3n)).toBe('3n');
    expect(stableSerialize(true)).toBe('true');
    expect(stableSerialize('x')).toBe('"x"');
    expect(stableSerialize(new Date(5))).toBe('Date(5)');
    expect(stableSerialize([1, 'a'])).toBe('[1,"a"]');
    expect(stableSerialize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it('serializes objects identically regardless of key insertion order', () => {
    expect(stableSerialize({ b: 2, a: 1 })).toBe(stableSerialize({ a: 1, b: 2 }));
    expect(stableSerialize({ a: 1, b: 2 })).not.toBe(stableSerialize({ a: 2, b: 1 }));
  });

  it('keeps nested structures injective', () => {
    expect(stableSerialize({ a: { b: 1 } })).not.toBe(stableSerialize({ a: { b: '1' } }));
    expect(stableSerialize([{ a: 1 }])).not.toBe(stableSerialize([{ a: [1] }]));
  });
});

describe('semanticValue identity tokens', () => {
  it('serializes scalars structurally and keeps number/string spellings apart', () => {
    expect(semanticValue(1)).not.toBe(semanticValue('1'));
    expect(semanticValue(null)).not.toBe(semanticValue('null'));
    expect(semanticValue(undefined)).not.toBe(semanticValue('undefined'));
  });

  it('gives one function a stable token and different functions different tokens', () => {
    const first = () => 1;
    const second = () => 2;
    expect(semanticValue(first)).toBe(semanticValue(first));
    expect(semanticValue(first)).not.toBe(semanticValue(second));
    expect(semanticValue(first)).toMatch(/^function:/);
  });

  it('serializes plain and null-prototype objects structurally with sorted keys', () => {
    expect(semanticValue({ b: 2, a: 1 })).toBe(semanticValue({ a: 1, b: 2 }));
    expect(semanticValue({ a: 1 })).not.toBe(semanticValue({ a: 2 }));
    const bare = Object.create(null) as Record<string, unknown>;
    bare.a = 1;
    expect(semanticValue(bare)).toBe(semanticValue({ a: 1 }));
  });

  it('never collides a scalar with a same-spelling string or array wrapper', () => {
    const outputs = [semanticValue(true), semanticValue('true'), semanticValue([1]), semanticValue(['1']), semanticValue(1)];
    expect(new Set(outputs).size).toBe(5);
  });

  it('compares arrays structurally rather than by reference identity', () => {
    expect(semanticValue([1, 'a'])).toBe(semanticValue([1, 'a']));
    expect(semanticValue([1])).not.toBe(semanticValue({ '0': 1 }));
  });

  it('gives an exotic object a stable per-identity token distinct from its structural spelling', () => {
    const exotic = new Map([['a', 1]]);
    expect(semanticValue(exotic)).toBe(semanticValue(exotic));
    expect(semanticValue(exotic)).toMatch(/^object:/);
    expect(semanticValue(exotic)).not.toBe(semanticValue(new Map([['a', 1]])));
    expect(semanticValue(new Map())).not.toBe(semanticValue({}));
  });
});

describe('compositeKey segment boundaries', () => {
  it('keeps different segmentations of the same text distinct', () => {
    expect(compositeKey('a', 'bc')).not.toBe(compositeKey('ab', 'c'));
    expect(compositeKey('a', 'b', 'c')).not.toBe(compositeKey('a', 'bc'));
  });
});
