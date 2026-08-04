import { defineModelRuntime, f } from '../../testApi';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';


/**
 * The declared sort is the order authority for every read surface of a client-sorted scope:
 * `read()`, `use()`, and `useCount` agree on one row set materialized in comparator order.
 * Persisted `orderKey` entries carry the order only for server-order scopes.
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

  it('serves scope.read() in declared comparator order', () => {
    const rows = build('Read', () => {});

    expect(rows.scopes.feed.read({ bucket: 'a' }).map(row => row.id)).toEqual(['r-1', 'r-2', 'r-3']);
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
