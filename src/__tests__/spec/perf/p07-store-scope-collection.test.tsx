import React, { act, useState } from 'react';
import TestRenderer from 'react-test-renderer';
import { defineModelRuntime, f, residencySnapshot, resetRuntime } from '../../testApi';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

type ScopeReadWork = { fullRows: number; incrementalRows: number };

const scopeReadWork = (): { snapshot: () => ScopeReadWork; reset: () => void } =>
  (globalThis as Record<string, unknown>).__DBLAYER_SCOPE_READ_WORK__ as { snapshot: () => ScopeReadWork; reset: () => void };

const storeScopeCollections = (): { count: () => number } => ({ count: () => residencySnapshot().derivedCollections ?? 0 });

const createRows = (tag: string) =>
  defineModelRuntime({
    id: `SpecScopeCollectionRows${tag}`,
    name: `SpecScopeCollectionRows${tag}`,
    fields: { bucket: f.str(), rank: f.num() },
    scopes: {
      bucket: ({ by: { bucket: 'bucket' }, sort: { field: 'rank', dir: 'asc' } })
    }
  });

describe('store scope collection', () => {
  it('(a) processes one inserted scope row without a size-dependent full read', () => {
    const measure = (size: number): ScopeReadWork => {
      setupSpecRuntime();
      const rows = createRows(`${size}`);
      rows.insertMany(Array.from({ length: size }, (_, index) => ({ id: `row-${index}`, bucket: 'all', rank: index * 2 })));
      const reader = renderCounted(() => rows.scopes.bucket.use({ bucket: 'all' }));
      scopeReadWork().reset();
      act(() => {
        rows.insert({ id: `row-${size}`, bucket: 'all', rank: size });
      });
      const result = scopeReadWork().snapshot();
      reader.unmount();
      return result;
    };

    const small = measure(300);
    const large = measure(3000);

    expect({ small, large }).toEqual({
      small: { fullRows: 0, incrementalRows: 1 },
      large: { fullRows: 0, incrementalRows: 1 }
    });
  });

  it('(b) releases scoped live collections after scope traversal and runtime reset', () => {
    setupSpecRuntime();
    const rows = createRows('Lifecycle');
    rows.insertMany(Array.from({ length: 20 }, (_, index) => ({ id: `row-${index}`, bucket: `bucket-${index}`, rank: index })));
    let setBucket!: (bucket: string) => void;
    const Reader = () => {
      const [bucket, setCurrentBucket] = useState('bucket-0');
      setBucket = setCurrentBucket;
      rows.scopes.bucket.use({ bucket });
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(Reader));
    });

    expect(storeScopeCollections().count()).toBe(1);
    for (let index = 1; index < 20; index += 1) {
      act(() => {
        setBucket(`bucket-${index}`);
      });
      expect(storeScopeCollections().count()).toBe(1);
    }

    act(() => root.unmount());
    expect(storeScopeCollections().count()).toBe(0);

    act(() => {
      root = TestRenderer.create(React.createElement(Reader));
    });
    expect(storeScopeCollections().count()).toBe(1);
    resetRuntime();
    expect(storeScopeCollections().count()).toBe(0);
    act(() => root.unmount());
  });
});
