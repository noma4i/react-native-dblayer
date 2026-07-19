import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { DbProvider, defineModel, f, resetRuntime, scope } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

type StoryRow = { id: string; bucket: string; label: string };

const createStories = (suffix: string) =>
  defineModel({
    id: `SpecSeed${suffix}`,
    name: `SpecSeed${suffix}`,
    fields: { id: f.str(), bucket: f.str(), label: f.str() },
    scopes: {
      byBucket: scope<StoryRow>({ by: { bucket: 'bucket' }, sort: 'server-order' }),
      featured: scope<StoryRow>({ sort: 'server-order' })
    }
  });

describe('public seed surface', () => {
  // Performance scale guarantee: N/A because seed is an explicit dev/test setup operation.
  it('seeds normalized model rows through one reactive commit wave', () => {
    setupSpecRuntime();
    const stories = createStories('Model');
    const reader = renderCounted(() => stories.scopes.byBucket.use({ bucket: 'A' }));
    const before = reader.renders();

    act(() => {
      stories.seed([
        { id: 'story-1', bucket: 'A', label: 'One' },
        { id: 'story-2', bucket: 'A', label: 'Two' }
      ]);
    });

    expect(reader.renders() - before).toBe(1);
    expect(reader.result().map(row => row.id)).toEqual(['story-1', 'story-2']);
    reader.unmount();
  });

  it('seeds explicit scope membership in the provided order', () => {
    setupSpecRuntime();
    const stories = createStories('Scope');

    stories.scopes.featured.seed(
      { bucket: 'featured' },
      [
        { id: 'story-2', bucket: 'B', label: 'Two' },
        { id: 'story-1', bucket: 'A', label: 'One' }
      ]
    );

    expect(stories.scopes.featured.read({ bucket: 'featured' }).map(row => row.id)).toEqual(['story-2', 'story-1']);
  });

  it('keeps reader identity and emits no render for an idempotent seed', () => {
    setupSpecRuntime();
    const stories = createStories('Idempotent');
    const rows = [{ id: 'story-1', bucket: 'A', label: 'One' }];
    stories.seed(rows);
    const reader = renderCounted(() => stories.scopes.byBucket.use({ bucket: 'A' }));
    const first = reader.result();
    const before = reader.renders();

    act(() => stories.seed(rows));

    expect(reader.renders() - before).toBe(0);
    expect(reader.result()).toBe(first);
    reader.unmount();
  });

  it('clears seeded rows and memberships on reset', () => {
    setupSpecRuntime();
    const stories = createStories('Reset');
    stories.seed([{ id: 'story-1', bucket: 'A', label: 'One' }]);
    const reader = renderCounted(() => stories.scopes.byBucket.use({ bucket: 'A' }));

    act(() => resetRuntime());

    expect(stories.get('story-1')).toBeUndefined();
    expect(reader.result()).toEqual([]);
    reader.unmount();
  });

  it('boots under DbProvider with only the minimal configured transport seam', async () => {
    const { transport } = setupSpecRuntime();
    const stories = createStories('Provider');
    stories.seed([{ id: 'story-1', bucket: 'A', label: 'One' }]);
    let root!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(React.Fragment)));
      await Promise.resolve();
    });

    expect(stories.get('story-1')?.label).toBe('One');
    expect(transport.calls).toEqual([]);
    act(() => root.unmount());
  });

  it('retains no seed reader after unmount', () => {
    setupSpecRuntime();
    const stories = createStories('Teardown');
    const reader = renderCounted(() => stories.scopes.byBucket.use({ bucket: 'A' }));
    const before = reader.renders();
    reader.unmount();

    stories.seed([{ id: 'story-1', bucket: 'A', label: 'One' }]);

    expect(reader.renders()).toBe(before);
  });
});
