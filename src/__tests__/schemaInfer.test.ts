import { f } from '../schema/f';
import type { FieldSpec } from '../schema/fieldSpec';
import type { InferInput, InferShapeStored, InferSparseInput, InferStored } from '../schema/infer';
import { createSchema } from '../schema/schema';
import { defineShape } from '../schema/shape';

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
    ? true
    : false
  : false;

type FixtureInput = {
  id?: string | number | null;
  title?: unknown;
  count?: unknown;
  label?: unknown;
  nickname?: unknown;
  note?: unknown;
  status?: unknown;
  data?: unknown;
  media?: unknown;
  attachments?: unknown;
  memberIds?: unknown;
  custom?: { value?: unknown };
};

type MediaInput = {
  url?: unknown;
  coverUrl?: unknown;
  width?: unknown;
  height?: unknown;
  label?: unknown;
};

const mediaShape = defineShape<MediaInput>()({
  url: f.str(),
  coverUrl: f.str().nullDefault(),
  width: f.num().nullDefault(),
  height: f.num().nullDefault(),
  label: f.str().nullable().optional()
});

const fields = {
  title: f.str(),
  count: f.num(),
  label: f.str().nullable(),
  nickname: f.str().optional(),
  note: f.str().nullable().optional(),
  status: f.enum<'open' | 'closed'>(),
  data: f.raw<{ value: string }>(),
  media: f.object(mediaShape).nullable(),
  attachments: f.array(mediaShape).optional(),
  memberIds: f.array(f.id()).optional(),
  custom: f.custom<string, FixtureInput>(input => (typeof input.custom?.value === 'string' ? input.custom.value : undefined)).optional()
} satisfies Record<string, FieldSpec<FixtureInput, any, any>>;

const schema = createSchema<FixtureInput, typeof fields>({ fields });

type Stored = InferStored<typeof schema>;
type ExpectedStored = {
  id: string;
  title: string;
  count: number;
  label: string | null;
  status: 'open' | 'closed';
  data: { value: string };
  media: {
    url: string;
    coverUrl: string | null;
    width: number | null;
    height: number | null;
    label?: string | null;
  } | null;
  nickname?: string;
  note?: string | null;
  attachments?: Array<{
    url: string;
    coverUrl: string | null;
    width: number | null;
    height: number | null;
    label?: string | null;
  }>;
  memberIds?: string[];
  custom?: string;
};

type Sparse = InferSparseInput<typeof schema>;
type ExpectedSparse = {
  id: string;
  title?: string;
  count?: number;
  label?: string | null;
  status?: 'open' | 'closed';
  data?: { value: string };
  media?: {
    url: string;
    coverUrl: string | null;
    width: number | null;
    height: number | null;
    label?: string | null;
  } | null;
  nickname?: string;
  note?: string | null;
  attachments?: Array<{
    url: string;
    coverUrl: string | null;
    width: number | null;
    height: number | null;
    label?: string | null;
  }>;
  memberIds?: string[];
  custom?: string;
};

type ModelConstraint = { id: string; updatedAt?: string | null };

type _StoredShape = Expect<Equal<Stored, ExpectedStored>>;
type _InputShape = Expect<Equal<InferInput<typeof schema>, FixtureInput>>;
type _SparseShape = Expect<Equal<Sparse, ExpectedSparse>>;
type _ShapeStored = Expect<
  Equal<
    InferShapeStored<typeof mediaShape>,
    {
      url: string;
      coverUrl: string | null;
      width: number | null;
      height: number | null;
      label?: string | null;
    }
  >
>;
type _ModelConstraintAssignable = Expect<Stored extends ModelConstraint ? true : false>;

describe('schema inference', () => {
  it('compiles', () => {
    expect(schema.fields.title.mode).toBe('required');
  });
});
