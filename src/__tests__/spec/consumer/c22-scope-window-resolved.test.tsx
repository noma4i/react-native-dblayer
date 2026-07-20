import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { defineModel, f, scope } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

type StoryRow = { id: string; bucket: string; title: string };

const createStories = () =>
  defineModel({
    id: 'SpecScopeWindowResolvedStories',
    name: 'SpecScopeWindowResolvedStories',
    fields: {
      bucket: f.str(),
      title: f.str()
    },
    scopes: {
      byBucket: scope<StoryRow>({ by: { bucket: 'bucket' } })
    }
  });

describe('scope window resolved state', () => {
  it('flips resolved on an empty scope reconcile without adding rows', () => {
    setupSpecRuntime();
    const stories = createStories();
    const reader = renderCounted(() => stories.scopes.byBucket.useWindow({ bucket: 'empty' }));
    const before = reader.renders();

    expect({ resolved: reader.result().resolved, rows: reader.result().rows }).toEqual({ resolved: false, rows: [] });
    act(() => {
      stories.scopes.byBucket.seed({ bucket: 'empty' }, []);
    });

    expect(reader.renders() - before).toBe(1);
    expect({ resolved: reader.result().resolved, rows: reader.result().rows }).toEqual({ resolved: true, rows: [] });
    reader.unmount();
  });

  it('reports resolved with rows after a non-empty scope reconcile', () => {
    setupSpecRuntime();
    const stories = createStories();
    const reader = renderCounted(() => stories.scopes.byBucket.useWindow({ bucket: 'featured' }));

    act(() => {
      stories.scopes.byBucket.seed({ bucket: 'featured' }, [{ id: 'story-1', bucket: 'featured', title: 'First' }]);
    });

    expect({ resolved: reader.result().resolved, rows: reader.result().rows.map(row => row.id) }).toEqual({ resolved: true, rows: ['story-1'] });
    reader.unmount();
  });

  it('keeps resolved scoped to the current key while retaining previous rows', () => {
    setupSpecRuntime();
    const stories = createStories();
    let result!: ReturnType<typeof stories.scopes.byBucket.useWindow>;
    let root!: TestRenderer.ReactTestRenderer;

    const Reader = ({ bucket }: { bucket: string }) => {
      result = stories.scopes.byBucket.useWindow({ bucket }, { keepPrevious: true });
      return null;
    };

    act(() => {
      root = TestRenderer.create(React.createElement(Reader, { bucket: 'A' }));
      stories.scopes.byBucket.seed({ bucket: 'A' }, [{ id: 'story-1', bucket: 'A', title: 'First' }]);
    });
    expect({ resolved: result.resolved, rows: result.rows.map(row => row.id) }).toEqual({ resolved: true, rows: ['story-1'] });

    act(() => {
      root.update(React.createElement(Reader, { bucket: 'B' }));
    });
    expect({ isPreviousData: result.isPreviousData, resolved: result.resolved, rows: result.rows.map(row => row.id) }).toEqual({
      isPreviousData: true,
      resolved: false,
      rows: ['story-1']
    });

    act(() => {
      stories.scopes.byBucket.seed({ bucket: 'B' }, []);
    });
    expect({ isPreviousData: result.isPreviousData, resolved: result.resolved, rows: result.rows }).toEqual({ isPreviousData: false, resolved: true, rows: [] });
    act(() => root.unmount());
  });
});
