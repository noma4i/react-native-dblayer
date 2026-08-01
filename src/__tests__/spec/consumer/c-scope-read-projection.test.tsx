import { defineModelRuntime, f } from '../../testApi';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';


/**
 * Scope order is persisted as `orderKey` at planning time; every read surface is a mechanical
 * projection of the plane's entry order. A comparator-sorted scope therefore runs its comparator
 * ONLY while planning writes - an imperative `read()`, a mounted `view`, and a mounted `useCount`
 * do zero comparator work and agree on one row set.
 */
describe('scope read projection', () => {
  const build = (tag: string, onCompare: () => void) => {
    setupSpecRuntime();
    const rows = defineModelRuntime({
      id: `SpecScopeReadProjection${tag}`,
      name: `SpecScopeReadProjection${tag}`,
      fields: { bucket: f.str(), rank: f.num(), label: f.str() },
      scopes: {
        feed: ({
          by: { bucket: 'bucket' },
          sort: {
            comparator: (left, right) => {
              onCompare();
              return left.rank - right.rank;
            },
            orderFields: ['rank']
          }
        })
      }
    });
    rows.scopes.feed.seed(
      { bucket: 'a' },
      [
        { id: 'r-3', bucket: 'a', rank: 3, label: 'third' },
        { id: 'r-1', bucket: 'a', rank: 1, label: 'first' },
        { id: 'r-2', bucket: 'a', rank: 2, label: 'second' }
      ]
    );
    return rows;
  };

  it('serves scope.read() from persisted entry order with zero comparator calls', () => {
    let compares = 0;
    const rows = build('Read', () => {
      compares += 1;
    });
    compares = 0;

    expect(rows.scopes.feed.read({ bucket: 'a' }).map(row => row.id)).toEqual(['r-1', 'r-2', 'r-3']);
    expect(compares).toBe(0);
  });

  it('serves useCount and use() from the one projected row set', () => {
    const rows = build('Count', () => {});
    const counter = renderCounted(() => rows.scopes.feed.useCount({ bucket: 'a' }));
    const reader = renderCounted(() => rows.scopes.feed.use({ bucket: 'a' }));

    expect(counter.result()).toBe(reader.result().length);
    expect(counter.result()).toBe(3);
    counter.unmount();
    reader.unmount();
  });
});
