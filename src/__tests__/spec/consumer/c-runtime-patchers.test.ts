import { createIdArrayPatcher, createKeyedArrayPatcher, createNestedObjectPatcher, defineModel, defineShape, f } from '../../../index';
import { setupSpecRuntime } from '../helpers/harness';

// Named behavioral contracts for the runtime patch helpers.

type ReactionInput = { emoji: string; count: number };

const reactionShape = defineShape<ReactionInput>()({
  emoji: f.str(),
  count: f.num()
});

describe('createKeyedArrayPatcher', () => {
  const patcher = createKeyedArrayPatcher(reactionShape, { key: 'emoji' });

  it('normalizes, replaces same-key entries and appends on upsert', () => {
    setupSpecRuntime();
    expect(patcher.upsert([{ emoji: 'a', count: 1 }], { emoji: 'a', count: 2, extra: 'dropped' })).toEqual([{ emoji: 'a', count: 2 }]);
    expect(patcher.upsert(null, { emoji: 'b', count: 1 })).toEqual([{ emoji: 'b', count: 1 }]);
  });

  it('removes entries by key and tolerates nullish arrays', () => {
    setupSpecRuntime();
    expect(
      patcher.remove(
        [
          { emoji: 'a', count: 1 },
          { emoji: 'b', count: 2 }
        ],
        'a'
      )
    ).toEqual([{ emoji: 'b', count: 2 }]);
    expect(patcher.remove(undefined, 'a')).toEqual([]);
  });

  it('throws a labelled error for an unreadable upsert payload', () => {
    setupSpecRuntime();
    expect(() => patcher.upsert([], null)).toThrow('Keyed array patch item: invalid shape payload');
  });
});

describe('createIdArrayPatcher', () => {
  const patcher = createIdArrayPatcher();

  it('dedupes and inserts at the requested edge on upsert', () => {
    setupSpecRuntime();
    expect(patcher.upsert(['a', 'b'], 'b', 'prepend')).toEqual(['b', 'a']);
    expect(patcher.upsert(null, 'x', 'append')).toEqual(['x']);
  });

  it('removes ids and tolerates nullish arrays', () => {
    setupSpecRuntime();
    expect(patcher.remove(['a', 'b'], 'a')).toEqual(['b']);
    expect(patcher.remove(undefined, 'a')).toEqual([]);
  });
});

type MediaState = { status: string; progress: number } | null;

const createMediaRows = (suffix: string) =>
  defineModel({
    id: `SpecConsumerNestedPatch${suffix}`,
    name: `SpecConsumerNestedPatch${suffix}`,
    fields: { id: f.str(), media: f.raw<MediaState>() }
  });

describe('createNestedObjectPatcher', () => {
  it('shallow-patches the nested object through the model and reports success', () => {
    setupSpecRuntime();
    const rows = createMediaRows('Apply');
    rows.insertStored({ id: 'r-1', media: { status: 'uploading', progress: 10 } });
    const patchProgress = createNestedObjectPatcher(rows, 'media', (current: NonNullable<MediaState>, progress: number) => ({ progress }));
    expect(patchProgress('r-1', 55)).toBe(true);
    expect(rows.get('r-1')?.media).toEqual({ status: 'uploading', progress: 55 });
  });

  it('returns false when the row or the nested object is missing', () => {
    setupSpecRuntime();
    const rows = createMediaRows('Missing');
    const patchProgress = createNestedObjectPatcher(rows, 'media', (current: NonNullable<MediaState>, progress: number) => ({ progress }));
    expect(patchProgress('absent', 1)).toBe(false);
    rows.insertStored({ id: 'r-2', media: null });
    expect(patchProgress('r-2', 1)).toBe(false);
    expect(rows.get('r-2')?.media ?? null).toBeNull();
  });
});
