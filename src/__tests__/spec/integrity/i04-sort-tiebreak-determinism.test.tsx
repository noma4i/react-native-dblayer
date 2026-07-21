import { act } from 'react-test-renderer';
import { defineModel, f, scope } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

// A2 audit guards: equal-sort-key ordering is deterministic and identical across read surfaces.
// Comparator canon: NULLS LAST, implicit locale-independent id tie-break, no session-local
// tie-break state. Scope reads (membership join) and model builder reads must never diverge
// on ties, and order must survive unmount/remount.

type ItemRow = { id: string; status: string; score: number };

const createItems = (suffix: string) =>
  defineModel({
    id: `SpecIntegrityTiebreak${suffix}`,
    name: `SpecIntegrityTiebreak${suffix}`,
    fields: { id: f.str(), status: f.str(), score: f.num() },
    scopes: {
      list: scope<ItemRow>({ by: { status: 'status' }, sort: { field: 'score', dir: 'desc' } })
    }
  });

describe('sort tie-break determinism (A2)', () => {
  it('orders equal-key rows identically in scope reads and builder reads (id tie-break)', () => {
    setupSpecRuntime();
    const items = createItems('CrossSurface');

    const scopeReader = renderCounted(() => items.scopes.list.use({ status: 'ready' }));
    act(() => {
      items.insertStored({ id: 'b-row', status: 'ready', score: 5 });
    });
    act(() => {
      items.insertStored({ id: 'a-row', status: 'ready', score: 5 });
    });

    const builderReader = renderCounted(() => items.use.where({ status: 'ready' }).orderBy('score', 'desc').rows());

    expect(scopeReader.result().map(row => row.id)).toEqual(builderReader.result().map(row => row.id));
    expect(builderReader.result().map(row => row.id)).toEqual(['a-row', 'b-row']);

    scopeReader.unmount();
    builderReader.unmount();
  });

  it('keeps live scope order for equal-key rows unchanged across unmount/remount', () => {
    setupSpecRuntime();
    const items = createItems('Remount');

    const liveReader = renderCounted(() => items.scopes.list.use({ status: 'ready' }));
    act(() => {
      items.insertStored({ id: 'b-row', status: 'ready', score: 5 });
    });
    act(() => {
      items.insertStored({ id: 'a-row', status: 'ready', score: 5 });
    });
    const liveOrder = liveReader.result().map(row => row.id);
    liveReader.unmount();

    const remountedReader = renderCounted(() => items.scopes.list.use({ status: 'ready' }));
    const remountedOrder = remountedReader.result().map(row => row.id);
    remountedReader.unmount();

    expect(remountedOrder).toEqual(liveOrder);
    expect(remountedOrder).toEqual(['a-row', 'b-row']);
  });
});
