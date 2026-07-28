import { act } from 'react';
import { defineModel, f, scope } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

type ItemRow = { id: string; groupId: string; media?: string };

const createItemsModel = (suffix: string) =>
  defineModel({
    id: `SpecScopeRequire${suffix}`,
    name: `SpecScopeRequire${suffix}`,
    fields: { groupId: f.str(), media: f.str().optional() },
    scopes: {
      group: scope<ItemRow>({ by: { groupId: 'groupId' } })
    }
  });

describe('scope require gate', () => {
  it('(a) filters a row missing a required field; without require it is returned as-is (contrast baseline)', () => {
    setupSpecRuntime();
    const items = createItemsModel('Filter');
    items.insert({ id: 'item-1', groupId: 'g1' });
    items.insert({ id: 'item-2', groupId: 'g1', media: 'video' });

    // Contrast: current (pre-gate) behavior - a partial row renders as-is without `require`.
    const withoutRequire = renderCounted(() => items.scopes.group.use({ groupId: 'g1' }));
    expect(withoutRequire.result().map(row => row.id).sort()).toEqual(['item-1', 'item-2']);
    withoutRequire.unmount();

    // The gated case: red before the fix (no filtering existed for scope reads), green after.
    const withRequire = renderCounted(() => items.scopes.group.use({ groupId: 'g1' }, { require: ['media'] }));
    expect(withRequire.result().map(row => row.id)).toEqual(['item-2']);
    withRequire.unmount();
  });

  it('(b) a healed row appears in the require-gated read with exactly one re-render on arrival', () => {
    setupSpecRuntime();
    const items = createItemsModel('Heal');
    items.insert({ id: 'item-1', groupId: 'g1' });
    const reader = renderCounted(() => items.scopes.group.use({ groupId: 'g1' }, { require: ['media'] }));
    expect(reader.result()).toEqual([]);
    const rendersBefore = reader.renders();

    act(() => {
      items.update('item-1', { media: 'video' });
    });

    expect(reader.renders() - rendersBefore).toBe(1);
    expect(reader.result().map(row => row.id)).toEqual(['item-1']);
    reader.unmount();
  });

  it('(c) an unrelated commit does not re-create the require-gated result when membership stays complete', () => {
    setupSpecRuntime();
    const items = createItemsModel('Identity');
    items.insert({ id: 'item-1', groupId: 'g1', media: 'video' });
    items.insert({ id: 'item-2', groupId: 'g1', media: 'photo' });
    items.insert({ id: 'other-1', groupId: 'g2', media: 'video' });

    const reader = renderCounted(() => items.scopes.group.use({ groupId: 'g1' }, { require: ['media'] }));
    const firstResult = reader.result();
    const rendersBefore = reader.renders();

    act(() => {
      items.update('other-1', { media: 'updated' });
    });

    expect(reader.renders()).toBe(rendersBefore);
    expect(reader.result()).toBe(firstResult);
    reader.unmount();
  });

  it('(d) useWindow excludes a partial row from rows/totalCount; hasMore stays correct', () => {
    setupSpecRuntime();
    const items = createItemsModel('Window');
    items.insertMany(Array.from({ length: 25 }, (_, index) => ({ id: `item-${index}`, groupId: 'g1', media: index === 10 ? undefined : `media-${index}` })));

    const reader = renderCounted(() => items.scopes.group.useWindow({ groupId: 'g1' }, { pageSize: 20, require: ['media'] }));
    const window = reader.result();

    expect(window.rows.some(row => row.id === 'item-10')).toBe(false);
    expect(window.totalCount).toBe(24);
    expect(window.rows.length).toBe(20);
    expect(window.hasMore).toBe(true);
    reader.unmount();
  });

  it('(e) 50 commits to unrelated rows produce 0 extra renders on the require-gated reader', () => {
    setupSpecRuntime();
    const items = createItemsModel('Budget');
    items.insert({ id: 'item-1', groupId: 'g1', media: 'video' });
    items.insertMany(Array.from({ length: 50 }, (_, index) => ({ id: `other-${index}`, groupId: 'g2', media: 'video' })));

    const reader = renderCounted(() => items.scopes.group.use({ groupId: 'g1' }, { require: ['media'] }));
    const rendersBefore = reader.renders();

    for (let index = 0; index < 50; index += 1) {
      act(() => {
        items.update(`other-${index}`, { media: `updated-${index}` });
      });
    }

    expect(reader.renders()).toBe(rendersBefore);
    reader.unmount();
  });
});
