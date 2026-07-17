import { f } from '../schema/f';
import type { FieldSpec } from '../schema/fieldSpec';
import { createSchema } from '../schema/schema';
import { readBoolean, readNullableString, readNumber, readString, toStr } from '../utils/normalizeHelpers';

type FixtureInput = {
  id?: string | number | null;
  name?: unknown;
  score?: unknown;
  active?: unknown;
  ownerId?: unknown;
  kind?: unknown;
  meta?: unknown;
  coverUrl?: unknown;
  nickname?: unknown;
  updatedAt?: unknown;
  optionalNote?: unknown;
  nested?: { title?: unknown };
  custom?: { value?: unknown };
  keep?: boolean;
  momentId?: unknown;
  similarMomentId?: unknown;
};

const fields = {
  name: f.str(),
  score: f.num(),
  active: f.bool(),
  ownerId: f.id(),
  kind: f.enum<'primary' | 'secondary'>(),
  meta: f.raw<Record<string, unknown>>(),
  coverUrl: f.str().nullDefault(),
  nickname: f.str().optional(),
  updatedAt: f.str().nullable(),
  optionalNote: f.str().nullable().optional(),
  nestedTitle: f.str().from<FixtureInput>(input => input.nested?.title),
  customValue: f.custom<string, FixtureInput>(input => {
    const value = input.custom?.value;
    return typeof value === 'string' ? value : undefined;
  })
} satisfies Record<string, FieldSpec<FixtureInput, any, any>>;

const fixtureSchema = createSchema<FixtureInput, typeof fields>({
  fields,
  guard: input => input.keep !== false
});

const referenceNormalize = (input: FixtureInput) => {
  if (input.keep === false) return null;

  const id = toStr(input.id);
  if (!id) return null;

  const output: Record<string, unknown> & { id: string } = { id };

  const name = readString(input.name);
  if (name !== undefined) output.name = name;

  const score = readNumber(input.score);
  if (score !== undefined) output.score = score;

  const active = readBoolean(input.active);
  if (active !== undefined) output.active = active;

  if (typeof input.ownerId === 'string' || typeof input.ownerId === 'number') {
    output.ownerId = toStr(input.ownerId);
  }

  if (input.kind != null) output.kind = input.kind;
  if (input.meta != null) output.meta = input.meta;

  const coverUrl = readNullableString(input.coverUrl);
  if (coverUrl !== undefined) {
    output.coverUrl = coverUrl;
  } else if (input.coverUrl === undefined) {
    output.coverUrl = null;
  }

  const nickname = readString(input.nickname);
  if (nickname !== undefined) output.nickname = nickname;

  const updatedAt = readNullableString(input.updatedAt);
  if (updatedAt !== undefined) output.updatedAt = updatedAt;

  const optionalNote = readNullableString(input.optionalNote);
  if (optionalNote !== undefined) output.optionalNote = optionalNote;

  const nestedTitle = readString(input.nested?.title);
  if (nestedTitle !== undefined) output.nestedTitle = nestedTitle;

  const customValue = typeof input.custom?.value === 'string' ? input.custom.value : undefined;
  if (customValue !== undefined) output.customValue = customValue;

  return output;
};

describe('schema normalize', () => {
  it('matches a hand-written reference normalize for every field builder kind', () => {
    const input: FixtureInput = {
      id: '42',
      name: 'Ada',
      score: 10,
      active: false,
      ownerId: 7,
      kind: 'primary',
      meta: { tags: ['db'] },
      coverUrl: 'https://example.test/cover.png',
      nickname: 'ada',
      updatedAt: null,
      optionalNote: null,
      nested: { title: 'Nested title' },
      custom: { value: 'custom value' }
    };

    expect(fixtureSchema.normalize(input)).toEqual(referenceNormalize(input));
  });

  it('keeps sparse fields absent when reads return undefined', () => {
    const result = fixtureSchema.normalize({
      id: 'sparse',
      name: 'Sparse',
      score: 'bad',
      active: 'true',
      ownerId: false,
      kind: undefined,
      meta: null,
      coverUrl: undefined,
      updatedAt: 10,
      optionalNote: undefined,
      nested: { title: 123 },
      custom: { value: 456 }
    });

    expect(result).toEqual({ id: 'sparse', name: 'Sparse', coverUrl: null });
    expect(result && 'score' in result).toBe(false);
    expect(result && 'active' in result).toBe(false);
    expect(result && 'ownerId' in result).toBe(false);
    expect(result && 'kind' in result).toBe(false);
    expect(result && 'meta' in result).toBe(false);
    expect(result && 'updatedAt' in result).toBe(false);
    expect(result && 'optionalNote' in result).toBe(false);
    expect(result && 'nestedTitle' in result).toBe(false);
    expect(result && 'customValue' in result).toBe(false);
  });

  it('drops rows through guard and row id resolution', () => {
    expect(fixtureSchema.normalize({ id: 'drop', name: 'Drop', keep: false })).toBeNull();

    const toRowIdPart = (value: unknown): string | null => {
      const part = toStr(value);
      return part ? part : null;
    };
    const schemaWithRowId = createSchema<FixtureInput, typeof fields>({
      fields,
      rowId: input => {
        const moment = toRowIdPart(input.momentId);
        const similar = toRowIdPart(input.similarMomentId);
        return moment && similar ? `${moment}:${similar}` : null;
      }
    });

    expect(schemaWithRowId.normalize({ momentId: 'm1', similarMomentId: null, name: 'Missing part' })).toBeNull();
    expect(schemaWithRowId.normalize({ momentId: 'm1', similarMomentId: '', name: 'Empty part' })).toBeNull();
    expect(schemaWithRowId.normalize({ momentId: 'm1', similarMomentId: 's1', name: 'Composite' })?.id).toBe('m1:s1');
  });

  it('uses the default input id through toStr', () => {
    expect(fixtureSchema.normalize({ id: 123, name: 'Numeric id' })).toEqual({
      id: '123',
      name: 'Numeric id',
      coverUrl: null
    });
    expect(fixtureSchema.normalize({ id: '', name: 'Empty id' })).toBeNull();
    expect(fixtureSchema.normalize({ name: 'Missing id' })).toBeNull();
  });

  it('drops non-object input instead of throwing on the default id lookup', () => {
    expect(fixtureSchema.normalize(null as unknown as FixtureInput)).toBeNull();
    expect(fixtureSchema.normalize(undefined as unknown as FixtureInput)).toBeNull();
    expect(fixtureSchema.normalize('not-an-object' as unknown as FixtureInput)).toBeNull();
  });

  it('outputs exactly the keys with defined field values', () => {
    const result = fixtureSchema.normalize({
      id: 'keys',
      name: 'Keys',
      score: 1,
      coverUrl: null,
      nested: { title: 'Nested' }
    });

    expect(Object.keys(result ?? {}).sort()).toEqual(['coverUrl', 'id', 'name', 'nestedTitle', 'score']);
  });
});
