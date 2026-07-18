import { act } from 'react-test-renderer';
import { belongsTo, defineModel, f, resetRuntime, scope } from '../../index';
import { renderCounted, setupAcceptanceRuntime } from './harness';

describe('A18 require fields', () => {
  it('returns a row only after required fields are present, while null is present', () => {
    setupAcceptanceRuntime();
    const model = defineModel({ id: 'A18Row', name: 'A18Row', fields: { a: f.str(), b: f.str().nullable().optional() } });
    model.insertStored({ id: 'missing', a: 'a' });
    const reader = renderCounted(() => model.use.row('missing', { require: ['b'] }));
    expect(reader.result()).toBeUndefined();
    const before = reader.renders();
    act(() => { model.patch('missing', { b: 'ready' }); });
    expect(reader.renders() - before).toBe(1);
    expect(reader.result()?.b).toBe('ready');
    model.insertStored({ id: 'null', a: 'a', b: null });
    const nullReader = renderCounted(() => model.use.row('null', { require: ['b'] }));
    expect(nullReader.result()?.b).toBeNull();
    reader.unmount();
    nullReader.unmount();
  });

  it('skips incomplete first rows until they complete', () => {
    setupAcceptanceRuntime();
    const model = defineModel({ id: 'A18First', name: 'A18First', fields: { group: f.str(), rank: f.num(), b: f.str().optional() } });
    model.insertStoredMany([{ id: 'first', group: 'g', rank: 1 }, { id: 'second', group: 'g', rank: 2, b: 'ready' }]);
    const reader = renderCounted(() => model.use.first({ group: 'g' }, { orderBy: { field: 'rank', direction: 'asc' }, require: ['b'] }));
    expect(reader.result()?.id).toBe('second');
    const before = reader.renders();
    act(() => { model.patch('first', { b: 'now' }); });
    expect(reader.renders() - before).toBe(1);
    expect(reader.result()?.id).toBe('first');
    reader.unmount();
  });

  it('filters builder rows and ignores unrelated writes', () => {
    setupAcceptanceRuntime();
    const model = defineModel({ id: 'A18Builder', name: 'A18Builder', fields: { group: f.str(), b: f.str().optional() } });
    const other = defineModel({ id: 'A18Other', name: 'A18Other', fields: { title: f.str() } });
    model.insertStoredMany([{ id: 'missing', group: 'g' }, { id: 'ready', group: 'g', b: 'yes' }]);
    const reader = renderCounted(() => model.use.where({ group: 'g' }).require('b').rows());
    expect(reader.result().map(row => row.id)).toEqual(['ready']);
    const before = reader.renders();
    act(() => { other.insertStored({ id: 'other', title: 'ignored' }); });
    expect(reader.renders() - before).toBe(0);
    reader.unmount();
  });

  it('delivers incomplete required view includes as null and reacts only for that item', () => {
    setupAcceptanceRuntime();
    const author = defineModel({ id: 'A18Author', name: 'A18Author', fields: { fullName: f.str().optional() } });
    const chat = defineModel({ id: 'A18Chat', name: 'A18Chat', fields: { feed: f.str(), authorId: f.str(), title: f.str() }, scopes: { feed: scope({ by: { feed: 'feed' }, sort: 'server-order' }) }, relations: () => ({ author: belongsTo(author, { foreignKey: 'authorId' }) }) });
    author.insertStoredMany([{ id: 'missing' }, { id: 'ready', fullName: 'Ready' }]);
    chat.insertStoredMany([{ id: 'one', feed: 'f', authorId: 'missing', title: 'one' }, { id: 'two', feed: 'f', authorId: 'ready', title: 'two' }]);
    const view = chat.view('require-author', { source: 'feed', include: { author: { require: ['fullName'] } }, select: (row, included) => ({ id: row.id, author: included.author }), renderKeys: ['author'] });
    const reader = renderCounted(() => view.use({ feed: 'f' }));
    expect(reader.result()[0].author).toBeNull();
    const readyItem = reader.result()[1];
    const before = reader.renders();
    act(() => { author.patch('missing', { fullName: 'Now ready' }); });
    expect(reader.renders() - before).toBe(1);
    expect(reader.result()[0].author).toMatchObject({ fullName: 'Now ready' });
    expect(reader.result()[1]).toBe(readyItem);
    reader.unmount();
  });

  it('rehydrates a required reader after resetRuntime', () => {
    setupAcceptanceRuntime();
    const model = defineModel({ id: 'A18Reset', name: 'A18Reset', fields: { b: f.str().optional() } });
    model.insertStored({ id: 'row' });
    const reader = renderCounted(() => model.use.row('row', { require: ['b'] }));
    expect(reader.result()).toBeUndefined();
    act(() => { resetRuntime(); model.insertStored({ id: 'row', b: 'fresh' }); });
    expect(reader.result()?.b).toBe('fresh');
    reader.unmount();
  });

  it('narrows required fields at compile time', () => {
    setupAcceptanceRuntime();
    const model = defineModel({ id: 'A18Types', name: 'A18Types', fields: { b: f.str().optional() } });
    const reader = renderCounted(() => {
      const row = model.use.row('row', { require: ['b'] });
      if (!row) return '';
      const value: string = row.b;
      // @ts-expect-error require keys must belong to the model.
      model.use.row('row', { require: ['missing'] });
      return value;
    });
    reader.unmount();
  });
});
