import { belongsTo, configureDb, defineModel, f, hasMany, scope } from '../../../index';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

// Verifies the destroy/insert asymmetry in relation-effect processing during an identity swap
// (`Model.replace`, the same primitive `planReplace`/the mutation commit path and the app's own
// `momentUpdated` ingest reconciliation both use to swap a temp row for its server node).
//
// react-native-dblayer/src/core/relations.ts `deriveEffects`:
// - `destroyEffects` (relations.ts:238-266) runs for EVERY destroyed row unconditionally (called from
//   the `for (const destroyedRow of destroyedRows)` loop at relations.ts:279-284, no origin check
//   anywhere in that loop or inside `destroyEffects` itself). For a `belongsTo` counterCache it queues
//   an unconditional `{ kind: 'counter', delta: -1 }` (relations.ts:253-255) whenever the destroyed
//   row's `foreignKey` resolves and the optional `filter` matches - UNLESS the same plan also recorded
//   a matching pending increment for the same child (relations.ts:248-252, the same-plan
//   insert+destroy cancellation case, which does not apply to a replace of an already-counted row).
// - `upsertEffects` (relations.ts:220-236, which is what applies `counterCache` INCREMENTS and
//   `touch`) only runs when `acceptedRow.origin === 'event'` (the gate at relations.ts:275-277, inside
//   the `for (const acceptedRow of accepted)` loop). `planReplace` (dsl/defineModel.ts:1203-1222)
//   always tags its upsert `origin: 'replace'`, never `'event'` - so the identity swap's own insert
//   side NEVER reaches `upsertEffects`, regardless of whether `planReplace` is reached through the
//   mutation commit path (dsl/defineMutation.ts) or through the public `Model.replace()` wrapper
//   (dsl/defineModel.ts:1326, `replace: (oldId, next) => applyEvent(planReplace(...))` -
//   `applyEvent`, dsl/defineModel.ts:883-885, only upgrades an upsert's origin to `'event'` when the
//   op's own origin is `undefined`; `planReplace`'s upsert op already carries `origin: 'replace'`, so
//   `applyEvent` leaves it untouched).
//
// Net result: destroy-side counterCache effects are unconditional, insert-side counterCache effects
// are conditional on `origin === 'event'`, and `planReplace` never produces that origin for its own
// insert. So a `Model.replace()` identity swap decrements a matching counterCache with nothing on the
// insert side to compensate.
//
// Scope membership does NOT have this asymmetry: `planReplace` explicitly calls `captureMembership`
// then `restoreMembership` (dsl/defineModel.ts:1215,1220) as PART of its own op list, independent of
// `deriveEffects`'s generic `membershipForUpsert`/`detachForDestroy` handling - so membership is
// deliberately carried over by the replace primitive itself, unlike counterCache which has no such
// explicit compensation anywhere in `planReplace`.

type ItemRow = { id: string; parentId: string };
type ParentRow = { id: string; itemCount: number };

const createModels = (suffix: string) => {
  const parents = defineModel({
    id: `SpecIntegrityReplaceSymmetryParents${suffix}`,
    name: `SpecIntegrityReplaceSymmetryParents${suffix}`,
    fields: { id: f.str(), itemCount: f.num() }
  });
  const items = defineModel({
    id: `SpecIntegrityReplaceSymmetryItems${suffix}`,
    name: `SpecIntegrityReplaceSymmetryItems${suffix}`,
    fields: { id: f.str(), parentId: f.str() },
    scopes: { byParent: scope<ItemRow>({ by: { parentId: 'parentId' } }) },
    relations: () => ({
      // No `filter` at all, so the counterCache condition is guaranteed to count this row - the
      // hypothesis explicitly asks for a configuration where the counter's own conditions cannot be
      // the reason the effect is skipped.
      parent: belongsTo<ItemRow, ParentRow>(parents, { foreignKey: 'parentId', counterCache: { field: 'itemCount' } })
    })
  });
  const itemsIngest = items.ingest({
    itemCreated: { handler: payload => ({ upsert: payload as ItemRow }) }
  });
  return { parents, items, itemsIngest };
};

describe('replace effect symmetry (destroy vs insert during an identity swap)', () => {
  test.failing('GATE-PENDING(G2) counterCache: a Model.replace identity swap decrements the parent counter with nothing to restore it', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const { parents, items, itemsIngest } = createModels('Counter');
    parents.insert({ id: 'p-1', itemCount: 0 });

    // Establish a legitimately-counted baseline: an ingest apply carries `origin: 'event'`
    // (dsl/defineIngest.ts), which IS what `upsertEffects` requires, so this increment is real.
    itemsIngest.apply('itemCreated', { id: 'temp-1', parentId: 'p-1' });
    expect(parents.find('p-1')).toMatchObject({ itemCount: 1 });

    // Identity swap of the SAME logical child (temp id -> server id), the exact primitive the app's
    // momentUpdated ingest handler and the mutation commit path both use.
    items.replace('temp-1', { id: 'server-1', parentId: 'p-1' });

    expect(items.scopes.byParent.read({ parentId: 'p-1' }).map(row => row.id)).toEqual(['server-1']);
    // DESIRED: the parent still reflects one real child - identity swap is not a net removal.
    // ACTUAL today (per the mechanism documented above): destroyEffects decrements unconditionally
    // for the destroyed temp-1 row, upsertEffects never re-increments for the replace's own insert
    // (origin 'replace', not 'event') - the counter drops to 0 even though the child still exists.
    expect(parents.find('p-1')).toMatchObject({ itemCount: 1 });
  });

  it('scope membership: a Model.replace identity swap DOES carry the child over to the new id (no asymmetry)', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const { parents, items, itemsIngest } = createModels('Membership');
    parents.insert({ id: 'p-1', itemCount: 0 });
    itemsIngest.apply('itemCreated', { id: 'temp-1', parentId: 'p-1' });

    items.replace('temp-1', { id: 'server-1', parentId: 'p-1' });

    // planReplace explicitly captures and restores scope membership as part of its own op list
    // (dsl/defineModel.ts:1215,1220), independent of deriveEffects - this is expected to pass, and
    // is kept here as the symmetric counter-example to the counterCache case above.
    expect(items.scopes.byParent.read({ parentId: 'p-1' }).map(row => row.id)).toEqual(['server-1']);
    expect(items.find('temp-1')).toBeUndefined();
  });

  test.failing('GATE-PENDING(G2) hasMany dependent:destroy cascade: fires unconditionally on the destroyed side of a parent-model replace too', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const parents = defineModel({
      id: 'SpecIntegrityReplaceSymmetryCascadeParents',
      name: 'SpecIntegrityReplaceSymmetryCascadeParents',
      fields: { id: f.str() },
      relations: () => ({
        items: hasMany<ParentRow, ItemRow>(items, { foreignKey: 'parentId', dependent: 'destroy' })
      })
    });
    const items = defineModel({
      id: 'SpecIntegrityReplaceSymmetryCascadeItems',
      name: 'SpecIntegrityReplaceSymmetryCascadeItems',
      fields: { id: f.str(), parentId: f.str() }
    });
    parents.insert({ id: 'temp-parent', itemCount: 0 } as never);
    items.insert({ id: 'child-1', parentId: 'temp-parent' });

    // Identity swap of the PARENT (e.g. an optimistically-created chat/moment being replaced by its
    // server node): destroyEffects (relations.ts:257-264) runs unconditionally for the destroyed
    // temp-parent row and cascades a destroy to its live children, with no equivalent re-parenting
    // step on the replace's insert side.
    parents.replace('temp-parent', { id: 'server-parent' } as never);

    // DESIRED: the child survives the parent's identity swap, re-pointed at the new parent id.
    // ACTUAL today: the cascade destroys the child during the parent's destroy half of the replace,
    // and nothing on the insert half re-creates or re-parents it.
    expect(items.find('child-1')).toBeDefined();
  });
});
