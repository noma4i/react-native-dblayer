import { defineModelRuntime, f, getInternalScopeHandle } from '../../testApi';
import { diagnostics, setupSpecRuntime } from '../helpers/harness';

type Row = { id: string; bucket: string; rank: number };

/**
 * Data loss is reported only when data is actually lost. A reconcile that detaches nothing and a
 * retention pass that trims nothing leave no loss event: a diagnostic that fires on a healthy write
 * is worse than none, because it hides the writes that really did drop rows.
 */
describe('scope planning loss reporting', () => {
  let suffix = 0;
  const build = (maxRows?: number) => {
    setupSpecRuntime();
    const model = defineModelRuntime({
      id: `SpecScopePlanLoss${++suffix}`,
      name: `SpecScopePlanLoss${suffix}`,
      fields: { bucket: f.str(), rank: f.num() },
      scopes: {
        feed: ({
          by: { bucket: 'bucket' },
          sort: { comparator: (left: Row, right: Row) => left.rank - right.rank, orderFields: ['rank'] },
          ...(maxRows == null ? {} : { retention: { maxRows } })
        })
      }
    });
    diagnostics().reset();
    return model;
  };
  const lossEvents = () => diagnostics().snapshot().dataLossEvents;

  it('records no loss when a complete snapshot keeps every row it replaces', () => {
    const model = build();
    model.scopes.feed.seed({ bucket: 'a' }, [
      { id: 'r-1', bucket: 'a', rank: 1 },
      { id: 'r-2', bucket: 'a', rank: 2 }
    ]);
    diagnostics().reset();

    model.scopes.feed.seed({ bucket: 'a' }, [
      { id: 'r-1', bucket: 'a', rank: 1 },
      { id: 'r-2', bucket: 'a', rank: 2 },
      { id: 'r-3', bucket: 'a', rank: 3 }
    ]);

    expect(lossEvents()).toEqual([]);
    expect(model.scopes.feed.read({ bucket: 'a' }).map(row => row.id)).toEqual(['r-1', 'r-2', 'r-3']);
  });

  it('records one detach loss counting exactly the rows the snapshot dropped', () => {
    const model = build();
    model.scopes.feed.seed({ bucket: 'a' }, [
      { id: 'r-1', bucket: 'a', rank: 1 },
      { id: 'r-2', bucket: 'a', rank: 2 },
      { id: 'r-3', bucket: 'a', rank: 3 }
    ]);
    diagnostics().reset();

    model.scopes.feed.seed({ bucket: 'a' }, [{ id: 'r-2', bucket: 'a', rank: 2 }]);

    expect(lossEvents()).toEqual([{ mechanism: 'scope-complete-detach', model: model.modelId, count: 2 }]);
  });

  it('does not trim or report when the scope sits exactly at its retention limit', () => {
    const model = build(3);

    model.scopes.feed.seed({ bucket: 'a' }, [
      { id: 'r-1', bucket: 'a', rank: 1 },
      { id: 'r-2', bucket: 'a', rank: 2 },
      { id: 'r-3', bucket: 'a', rank: 3 }
    ]);

    // The limit is a ceiling, not a target.
    expect(model.scopes.feed.read({ bucket: 'a' }).map(row => row.id)).toEqual(['r-1', 'r-2', 'r-3']);
    expect(lossEvents()).toEqual([]);
  });

  it('trims past the limit and reports exactly the trimmed rows', () => {
    const model = build(2);

    model.scopes.feed.seed({ bucket: 'a' }, [
      { id: 'r-1', bucket: 'a', rank: 1 },
      { id: 'r-2', bucket: 'a', rank: 2 },
      { id: 'r-3', bucket: 'a', rank: 3 },
      { id: 'r-4', bucket: 'a', rank: 4 }
    ]);

    // Two rows over the limit: the report carries the real number, not the fact that a trim ran.
    expect(model.scopes.feed.read({ bucket: 'a' }).map(row => row.id)).toEqual(['r-1', 'r-2']);
    expect(lossEvents()).toEqual([{ mechanism: 'scope-retention-trim', model: model.modelId, count: 2 }]);
  });

  it('leaves an untouched sibling scope out of both the reconcile and the report', () => {
    const model = build();
    model.scopes.feed.seed({ bucket: 'a' }, [{ id: 'a-1', bucket: 'a', rank: 1 }]);
    model.scopes.feed.seed({ bucket: 'b' }, [{ id: 'b-1', bucket: 'b', rank: 1 }]);
    diagnostics().reset();

    model.scopes.feed.seed({ bucket: 'a' }, []);

    expect(lossEvents()).toEqual([{ mechanism: 'scope-complete-detach', model: model.modelId, count: 1 }]);
    expect(model.scopes.feed.read({ bucket: 'b' }).map(row => row.id)).toEqual(['b-1']);
  });

  it('[W40] counts a scope landing gated by a live tombstone at the plan and seed seams', () => {
    const model = build();
    model.scopes.feed.seed({ bucket: 'a' }, [{ id: 'r-1', bucket: 'a', rank: 1 }]);
    model.destroy('r-1');
    diagnostics().reset();

    getInternalScopeHandle(model.scopes.feed).apply({ bucket: 'a' }, [{ id: 'r-1', bucket: 'a', rank: 1 }], 'complete');
    expect(diagnostics().snapshot().tombstoneWriteDrops).toBe(1);

    model.scopes.feed.seed({ bucket: 'a' }, [{ id: 'r-1', bucket: 'a', rank: 1 }]);
    expect(diagnostics().snapshot().tombstoneWriteDrops).toBe(2);
    expect(model.scopes.feed.read({ bucket: 'a' })).toEqual([]);
  });
});
