import { computeSchemaFingerprint, registerSchemaDeclaration , stableSerialize } from '../../testApi';
import type { SchemaDeclaration } from '../../testApi';

const declaration = (id: string): SchemaDeclaration => ({
  id,
  name: id,
  fields: { title: { kind: 'str', mode: 'required', hasDefault: false } },
  scopes: {}
});

describe('schema fingerprint id ordering', () => {
  it('sorts declaration ids by codepoint order, not locale-dependent order, before fingerprinting', () => {
    const ids = ['zebra', 'Banana', 'apple'];
    for (const id of ids) registerSchemaDeclaration(declaration(id));

    // Pure codepoint order: uppercase 'B' (66) sorts before lowercase 'a' (97) and 'z' (122).
    // A locale-aware comparator (case-insensitive primary weight) instead orders this as apple, Banana, zebra.
    const codepointOrder = ['Banana', 'apple', 'zebra'];
    const expected = stableSerialize(codepointOrder.map(declaration));

    expect(computeSchemaFingerprint()).toBe(expected);
  });
});
