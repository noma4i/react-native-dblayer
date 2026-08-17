import { computeSchemaFingerprints, registerSchemaDeclaration } from '../../testApi';
import type { SchemaDeclaration } from '../../testApi';

const declaration = (id: string): SchemaDeclaration => ({
  id,
  name: id,
  fields: { title: { kind: 'str', mode: 'required', hasDefault: false } },
  scopes: {}
});

describe('schema fingerprint id ordering', () => {
  it('sorts declaration ids by codepoint order, not locale-dependent order, before fingerprinting', () => {
    // Registration order is deliberately not codepoint order: the fingerprint map must not follow it.
    for (const id of ['a[', 'a,', 'a']) registerSchemaDeclaration(declaration(id));

    const fingerprintOf = (id: string): string =>
      `{"fields":{"title":{"hasDefault":false,"kind":"str","mode":"required"}},"id":"${id}","name":"${id}","scopes":{}}`;

    expect(computeSchemaFingerprints()).toEqual({
      a: fingerprintOf('a'),
      'a,': fingerprintOf('a,'),
      'a[': fingerprintOf('a[')
    });
    expect(Object.keys(computeSchemaFingerprints())).toEqual(['a', 'a,', 'a[']);
  });
});
