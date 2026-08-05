import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { createCommitEnvelope, defineModelRuntime, f, getApplyRuntime, getApplyTarget } from '../../testApi';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';


const createStories = () =>
  defineModelRuntime({
    id: 'SpecScopeWindowResolvedStories',
    name: 'SpecScopeWindowResolvedStories',
    fields: {
      bucket: f.str(),
      title: f.str()
    },
    scopes: {
      byBucket: ({ by: { bucket: 'bucket' } })
    }
  });

describe('scope window resolved state', () => {
  it('keeps null scope reads inactive and resets stale window callbacks to their own key', () => {
    setupSpecRuntime();
    const stories = createStories();
    let windowResult!: ReturnType<typeof stories.scopes.byBucket.useWindow>;
    let nullRows!: ReturnType<typeof stories.scopes.byBucket.use>;
    let nullCount!: ReturnType<typeof stories.scopes.byBucket.useCount>;
    let root!: TestRenderer.ReactTestRenderer;

    const Reader = ({ bucket }: { bucket: string | null }) => {
      const scopeValue = bucket === null ? null : { bucket };
      nullRows = stories.scopes.byBucket.use(scopeValue);
      nullCount = stories.scopes.byBucket.useCount(scopeValue);
      windowResult = stories.scopes.byBucket.useWindow(scopeValue, { pageSize: 1 });
      return null;
    };

    act(() => {
      root = TestRenderer.create(React.createElement(Reader, { bucket: null }));
    });
    expect({ rows: nullRows, count: nullCount, window: windowResult.rows, resolved: windowResult.resolved }).toEqual({
      rows: [],
      count: 0,
      window: [],
      resolved: true
    });

    act(() => {
      root.update(React.createElement(Reader, { bucket: 'A' }));
      stories.scopes.byBucket.seed(
        { bucket: 'A' },
        [
          { id: 'story-a1', bucket: 'A', title: 'First' },
          { id: 'story-a2', bucket: 'A', title: 'Second' }
        ]
      );
    });
    const fetchNextForA = windowResult.fetchNextPage;

    act(() => {
      root.update(React.createElement(Reader, { bucket: 'B' }));
      stories.scopes.byBucket.seed(
        { bucket: 'B' },
        [
          { id: 'story-b1', bucket: 'B', title: 'First' },
          { id: 'story-b2', bucket: 'B', title: 'Second' }
        ]
      );
    });
    act(() => {
      fetchNextForA();
    });
    expect(windowResult.rows.map(row => row.id)).toEqual(['story-b1']);
    act(() => root.unmount());
  });

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

  it('orders equal scope keys by row id during an incremental insert', () => {
    setupSpecRuntime();
    const stories = createStories();
    // Rows are created BEFORE the scope exists, so membership arrives only through the
    // explicit scope-delta appends below; both rows genuinely belong to the target bucket.
    stories.insertMany([
      { id: 'story-b', bucket: 'equal', title: 'Second' },
      { id: 'story-a', bucket: 'equal', title: 'First' }
    ]);
    stories.scopes.byBucket.seed({ bucket: 'equal' }, []);
    const target = getApplyTarget(stories.modelId);
    const scopeKey = target.readAllScopeKeys().find(key => key.includes('equal'))!;
    getApplyRuntime().commit(
      createCommitEnvelope([{ kind: 'scope-delta', model: stories.modelId, scopeKey, append: [{ id: 'story-a', orderKey: 'V' }], detach: [] }])
    );
    const reader = renderCounted(() => stories.scopes.byBucket.use({ bucket: 'equal' }));
    expect(reader.result().map(row => row.id)).toEqual(['story-a']);

    act(() => {
      getApplyRuntime().commit(
        createCommitEnvelope([{ kind: 'scope-delta', model: stories.modelId, scopeKey, append: [{ id: 'story-b', orderKey: 'V' }], detach: [] }])
      );
    });

    expect(reader.result().map(row => row.id)).toEqual(['story-a', 'story-b']);
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
