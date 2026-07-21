import { act } from 'react-test-renderer';
import { belongsTo, defineModel, f, hasMany, hasOne } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

// use.related contracts: belongsTo/hasMany/hasOne reactive reads through declared relations.
// Each direction lives on its own acyclic pair: real consumers break relation cycles across
// modules, and a single spec file gets the same typed inference by never declaring both
// directions on one pair.

type AuthorRow = { id: string; name: string };
type PostRow = { id: string; authorId: string; title: string; seq: number };

const createBelongsToPair = (suffix: string) => {
  const authors = defineModel({
    id: `SpecRelBAuthors${suffix}`,
    name: `SpecRelBAuthors${suffix}`,
    fields: { id: f.str(), name: f.str() }
  });
  const posts = defineModel({
    id: `SpecRelBPosts${suffix}`,
    name: `SpecRelBPosts${suffix}`,
    fields: { id: f.str(), authorId: f.str(), title: f.str(), seq: f.num() },
    relations: () => ({
      author: belongsTo(authors, { foreignKey: 'authorId' })
    })
  });
  return { authors, posts };
};

const createHasPair = (suffix: string) => {
  const posts = defineModel({
    id: `SpecRelHPosts${suffix}`,
    name: `SpecRelHPosts${suffix}`,
    fields: { id: f.str(), authorId: f.str(), title: f.str(), seq: f.num() }
  });
  const authors = defineModel({
    id: `SpecRelHAuthors${suffix}`,
    name: `SpecRelHAuthors${suffix}`,
    fields: { id: f.str(), name: f.str() },
    relations: () => ({
      posts: hasMany(posts, { foreignKey: 'authorId' }),
      latestPost: hasOne(posts, { foreignKey: 'authorId', comparator: (left, right) => Number(right.seq) - Number(left.seq) })
    })
  });
  return { authors, posts };
};

describe('use.related', () => {
  it('belongsTo resolves the parent row and tracks parent updates', () => {
    setupSpecRuntime();
    const { authors, posts } = createBelongsToPair('BelongsTo');
    authors.insertStored({ id: 'u-1', name: 'Ann' });
    posts.insertStored({ id: 'p-1', authorId: 'u-1', title: 'Hello', seq: 1 });
    const reader = renderCounted(() => posts.use.related('p-1', 'author') as AuthorRow | undefined);
    expect(reader.result()?.name).toBe('Ann');
    act(() => {
      authors.patch('u-1', { name: 'Ann Updated' });
    });
    expect(reader.result()?.name).toBe('Ann Updated');
    reader.unmount();
  });

  it('hasMany lists target rows reactively', () => {
    setupSpecRuntime();
    const { authors, posts } = createHasPair('HasMany');
    authors.insertStored({ id: 'u-1', name: 'Ann' });
    posts.insertStored({ id: 'p-1', authorId: 'u-1', title: 'First', seq: 1 });
    const reader = renderCounted(() => authors.use.related('u-1', 'posts') as PostRow[]);
    expect(reader.result().map(row => row.id)).toEqual(['p-1']);
    act(() => {
      posts.insertStored({ id: 'p-2', authorId: 'u-1', title: 'Second', seq: 2 });
    });
    expect(reader.result().map(row => row.id).sort()).toEqual(['p-1', 'p-2']);
    reader.unmount();
  });

  it('hasOne picks the comparator-best target row', () => {
    setupSpecRuntime();
    const { authors, posts } = createHasPair('HasOne');
    authors.insertStored({ id: 'u-1', name: 'Ann' });
    posts.insertStoredMany([
      { id: 'p-1', authorId: 'u-1', title: 'Old', seq: 1 },
      { id: 'p-2', authorId: 'u-1', title: 'New', seq: 5 }
    ]);
    const reader = renderCounted(() => authors.use.related('u-1', 'latestPost') as PostRow | undefined);
    expect(reader.result()?.id).toBe('p-2');
    reader.unmount();
  });

  it('returns empty results for nullish ids and throws for unknown relation names', () => {
    setupSpecRuntime();
    const hasPair = createHasPair('Edges');
    const belongsPair = createBelongsToPair('Edges');
    hasPair.authors.insertStored({ id: 'u-1', name: 'Ann' });
    const many = renderCounted(() => hasPair.authors.use.related(null, 'posts') as PostRow[]);
    const one = renderCounted(() => belongsPair.posts.use.related(undefined, 'author') as AuthorRow | undefined);
    expect(many.result()).toEqual([]);
    expect(one.result()).toBeUndefined();
    many.unmount();
    one.unmount();
    expect(() => renderCounted(() => hasPair.authors.use.related('u-1', 'nonexistent'))).toThrow('has no relation nonexistent');
  });
});
