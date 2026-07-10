import { pickDefined, pickPresent } from '../utils/pickDefined';

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
    ? true
    : false
  : false;

type PatchInput = {
  name?: string | null;
  username?: string | null;
  filterDistance?: number | null;
  preferenceVibration?: boolean | null;
  untouched?: string;
};

describe('patch pickers', () => {
  it('picks defined values while preserving explicit null', () => {
    const input: PatchInput = {
      name: null,
      username: undefined,
      filterDistance: 25,
      preferenceVibration: false,
      untouched: 'skip'
    };

    expect(pickDefined(input, ['name', 'username', 'filterDistance', 'preferenceVibration'])).toEqual({
      name: null,
      filterDistance: 25,
      preferenceVibration: false
    });
  });

  it('picks present values while dropping null and undefined', () => {
    const input: PatchInput = {
      name: null,
      username: '',
      filterDistance: 0,
      preferenceVibration: false
    };

    expect(pickPresent(input, ['name', 'username', 'filterDistance', 'preferenceVibration'])).toEqual({
      username: '',
      filterDistance: 0,
      preferenceVibration: false
    });
  });

  it('types keys and result shape', () => {
    const input: PatchInput = {};
    const patch = pickDefined(input, ['name', 'filterDistance'] as const);
    const presentPatch = pickPresent(input, ['name', 'filterDistance'] as const);
    type _PatchShape = Expect<Equal<typeof patch, Partial<Pick<PatchInput, 'name' | 'filterDistance'>>>>;
    type _PresentPatchShape = Expect<Equal<typeof presentPatch, { name?: string; filterDistance?: number }>>;

    if (false) {
      // @ts-expect-error keys must exist on the source object
      pickDefined(input, ['missing'] as const);
      // @ts-expect-error keys must exist on the source object
      pickPresent(input, ['missing'] as const);
    }

    expect(patch).toEqual({});
    expect(presentPatch).toEqual({});
  });
});
