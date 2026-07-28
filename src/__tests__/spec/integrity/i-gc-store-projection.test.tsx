import { defineModel, f, scope } from '../../../index';
import { collectGarbage } from '../../../core/gc';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

type Row = { id: string; bucket: string; label: string };

/**
 * GC writes to the scope plane and the store through ONE seam: `publishProjectedBatch`. A GC
 * batch that reached the commit bus without store projection would leave orphaned membership
 * rows behind - a scope removed from the plane would keep serving rows through the store join.
 */
describe('gc store projection', () => {
  it('drops store memberships when GC removes an idle scope, so live entities do not resurrect it', () => {
    setupSpecRuntime();
    const rows = defineModel({
      id: 'SpecGcStoreProjection',
      name: 'SpecGcStoreProjection',
      fields: { bucket: f.str(), label: f.str() },
      scopes: { feed: scope<Row>({ by: { bucket: 'bucket' } }) },
      maintenance: { dropIdleScopesAfterMs: 0 }
    });
    rows.insertMany([
      { id: 'r-1', bucket: 'a', label: 'first' },
      { id: 'r-2', bucket: 'a', label: 'second' }
    ]);
    rows.scopes.feed.seed({ bucket: 'a' }, [
      { id: 'r-1', bucket: 'a', label: 'first' },
      { id: 'r-2', bucket: 'a', label: 'second' }
    ]);
    /** A model-dep reader keeps the ENTITIES alive while the idle scope itself has no reader and gets collected. */
    const entityRoot = renderCounted(() => rows.use.where({ bucket: 'a' }).rows());
    expect(entityRoot.result().map(row => row.id)).toEqual(['r-1', 'r-2']);

    collectGarbage();

    const scopeReader = renderCounted(() => rows.scopes.feed.use({ bucket: 'a' }));
    expect(scopeReader.result()).toEqual([]);
    expect(rows.find('r-1')).toMatchObject({ label: 'first' });
    scopeReader.unmount();
    entityRoot.unmount();
  });
});
