import { computeSchemaFingerprints, registerSchemaDeclaration , stableSerialize } from '../../testApi';
import type { SchemaDeclaration } from '../../testApi';

const declaration = (id: string): SchemaDeclaration => ({
  id,
  name: id,
  fields: { title: { kind: 'str', mode: 'required', hasDefault: false } },
  scopes: {}
});

describe('schema fingerprint id ordering', () => {
  it('sorts declaration ids by codepoint order, not locale-dependent order, before fingerprinting', () => {
    const ids = ['a[', 'a,', 'a'];
    for (const id of ids) registerSchemaDeclaration(declaration(id));

    // Array default sorting compares the serialized pair and misorders ids containing punctuation.
    const codepointOrder = ['a', 'a,', 'a['];
    const expected = Object.fromEntries(codepointOrder.map(id => [id, stableSerialize(declaration(id))]));

    expect(computeSchemaFingerprints()).toEqual(expected);
    expect(Object.keys(computeSchemaFingerprints())).toEqual(codepointOrder);
  });
});
