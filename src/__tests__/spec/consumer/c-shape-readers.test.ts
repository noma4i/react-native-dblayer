import { defineShape, f, projectShape, readObjectField, readShape, readShapeOrThrow } from '../../legacyTestApi';

// Named behavioral contracts for the shape boundary readers.

type SnapshotInput = { id: string; name: string; age: number };

const snapshotShape = defineShape<SnapshotInput>()({
  id: f.str(),
  name: f.str(),
  age: f.num()
});

describe('readShape', () => {
  it('returns undefined for non-object payloads', () => {
    expect(readShape(snapshotShape, null)).toBeUndefined();
    expect(readShape(snapshotShape, 'nope')).toBeUndefined();
    expect(readShape(snapshotShape, [1, 2])).toBeUndefined();
  });

  it('reads declared fields and drops unreadable values and undeclared keys', () => {
    expect(readShape(snapshotShape, { id: 'u-1', name: 'Ann', age: 'not-a-number', extra: true })).toStrictEqual({ id: 'u-1', name: 'Ann' });
  });

  it('keeps low-level object reads total for non-object input', () => {
    expect(readObjectField(null, 'name')).toBeUndefined();
    expect(readObjectField(['not', 'an', 'object'], 'name')).toBeUndefined();
  });
});

describe('readShapeOrThrow', () => {
  it('throws a labelled error for unreadable payloads', () => {
    expect(() => readShapeOrThrow(snapshotShape, null, 'UserSnapshot')).toThrow('UserSnapshot: invalid shape payload');
  });

  it('returns the normalized object for valid payloads', () => {
    expect(readShapeOrThrow(snapshotShape, { id: 'u-1', name: 'Ann', age: 30 }, 'UserSnapshot')).toEqual({ id: 'u-1', name: 'Ann', age: 30 });
  });
});

describe('projectShape', () => {
  it('projects a wider source down to shape fields with overrides winning last', () => {
    const source = { id: 'u-1', name: 'Ann', age: 30, unrelated: 'dropped' };
    expect(projectShape(snapshotShape, source, { name: 'Override' })).toEqual({ id: 'u-1', name: 'Override', age: 30 });
  });
});

describe('field defaults', () => {
  it('does not attach a factory default key when no default is declared', () => {
    expect(Object.prototype.hasOwnProperty.call(f.str(), 'factoryDefault')).toBe(false);
  });
});
