import { f } from '../schema/f';

describe('schema field builders', () => {
  describe('primitive field reads', () => {
    it.each([
      {
        name: 'str',
        spec: f.str(),
        malformedValue: 12,
        validValue: 'Alice',
        expectedMalformed: undefined,
        expectedValid: 'Alice'
      },
      {
        name: 'num',
        spec: f.num(),
        malformedValue: '12',
        validValue: 12,
        expectedMalformed: undefined,
        expectedValid: 12
      },
      {
        name: 'bool',
        spec: f.bool(),
        malformedValue: 'true',
        validValue: true,
        expectedMalformed: undefined,
        expectedValid: true
      },
      {
        name: 'id',
        spec: f.id(),
        malformedValue: false,
        validValue: 42,
        expectedMalformed: undefined,
        expectedValid: '42'
      },
      {
        name: 'enum',
        spec: f.enum<'ACTIVE' | 'ARCHIVED'>(),
        malformedValue: 7,
        validValue: 'ACTIVE',
        expectedMalformed: 7,
        expectedValid: 'ACTIVE'
      },
      {
        name: 'raw',
        spec: f.raw<string[]>(),
        malformedValue: 'not-an-array',
        validValue: ['a', 'b'],
        expectedMalformed: 'not-an-array',
        expectedValid: ['a', 'b']
      },
      {
        name: 'custom',
        spec: f.custom<string>(input => {
          if (typeof input !== 'object' || input === null) return undefined;
          const value = (input as { value?: { nested?: { value?: unknown } } }).value?.nested?.value;
          return typeof value === 'string' ? value : undefined;
        }),
        malformedValue: { nested: { value: 10 } },
        validValue: { nested: { value: 'custom-value' } },
        expectedMalformed: undefined,
        expectedValid: 'custom-value'
      }
    ])('handles missing, malformed, explicit null, and valid values for $name', ({ spec, malformedValue, validValue, expectedMalformed, expectedValid }) => {
      expect(spec.read({}, 'value')).toBeUndefined();
      expect(spec.read({ value: malformedValue }, 'value')).toEqual(expectedMalformed);
      expect(spec.read({ value: null }, 'value')).toBeUndefined();
      expect(spec.read({ value: validValue }, 'value')).toEqual(expectedValid);
    });

    it('coerces string ids without accepting unrelated primitive values', () => {
      const spec = f.id();

      expect(spec.read({ id: '42' }, 'id')).toBe('42');
      expect(spec.read({ id: 42 }, 'id')).toBe('42');
      expect(spec.read({ id: true }, 'id')).toBeUndefined();
    });
  });

  it('preserves explicit null only after nullable is applied', () => {
    expect(f.str().nullable().read({ value: null }, 'value')).toBeNull();
    expect(f.num().nullable().read({ value: null }, 'value')).toBeNull();
    expect(f.bool().nullable().read({ value: null }, 'value')).toBeNull();
    expect(f.id().nullable().read({ value: null }, 'value')).toBeNull();
    expect(f.enum<'ACTIVE'>().nullable().read({ value: null }, 'value')).toBeNull();
    expect(f.raw<string[]>().nullable().read({ value: null }, 'value')).toBeNull();
  });

  it('reads from selector output when from is applied', () => {
    const spec = f.str().from<{ profile?: { name?: unknown } }>(input => input.profile?.name);

    expect(spec.read({ profile: { name: 'Ada' } }, 'ignored')).toBe('Ada');
    expect(spec.read({ profile: { name: 1 } }, 'ignored')).toBeUndefined();
    expect(spec.read({}, 'ignored')).toBeUndefined();
  });

  it('treats selector exceptions as skipped writes', () => {
    const spec = f.str().from<{ profile?: { name: string } }>(input => input.profile!.name);

    expect(spec.read({}, 'ignored')).toBeUndefined();
  });

  it('keeps nullDefault dense while nullable remains sparse for missing keys', () => {
    const nullable = f.str().nullable();
    const dense = f.str().nullDefault();

    expect(nullable.mode).toBe('nullable');
    expect(dense.mode).toBe('nullable');
    expect(nullable.read({}, 'coverUrl')).toBeUndefined();
    expect(dense.read({}, 'coverUrl')).toBeNull();
    expect(nullable.read({ coverUrl: null }, 'coverUrl')).toBeNull();
    expect(dense.read({ coverUrl: null }, 'coverUrl')).toBeNull();
    expect(dense.read({ coverUrl: 1 }, 'coverUrl')).toBeUndefined();
  });

  it('keeps factory defaults out of read semantics', () => {
    const factoryDefault = f.str().default('factory');
    const factoryAndNullDefault = factoryDefault.nullDefault();

    expect(factoryDefault.factoryDefault).toBe('factory');
    expect(factoryDefault.read({}, 'value')).toBeUndefined();
    expect(factoryAndNullDefault.factoryDefault).toBe('factory');
    expect(factoryAndNullDefault.read({}, 'value')).toBeNull();
  });

  it('exposes optional mode transitions without mutating the source spec', () => {
    const required = f.str();
    const optional = required.optional();
    const nullable = required.nullable();
    const optionalNullable = nullable.optional();
    const nullableOptional = optional.nullable();

    expect(required.mode).toBe('required');
    expect(optional.mode).toBe('optional');
    expect(nullable.mode).toBe('nullable');
    expect(optionalNullable.mode).toBe('optionalNullable');
    expect(nullableOptional.mode).toBe('optionalNullable');
    expect(required.read({ value: null }, 'value')).toBeUndefined();
    expect(nullable.read({ value: null }, 'value')).toBeNull();
    expect(optional).not.toBe(required);
    expect(nullable).not.toBe(required);
  });
});
