import { collectGarbage } from '../../core/gc';
import { getOperationState } from '../../dsl/configure';
import { createInvariantFixture, mulberry32, storageByteSize, withSeedContext } from './session.helpers';

type PropertyOperation = { kind: 'page' | 'complete' | 'delta' | 'ingest' | 'optimisticCommit' | 'optimisticRollback' | 'destroy' | 'patch' | 'restart' | 'collect' | 'clock'; model: 'Alpha' | 'Beta'; bucket: string };

const operationsFor = (seed: number, count: number): PropertyOperation[] => {
  const random = mulberry32(seed);
  const kinds: PropertyOperation['kind'][] = ['page', 'complete', 'delta', 'ingest', 'optimisticCommit', 'optimisticRollback', 'destroy', 'patch', 'restart', 'collect', 'clock'];
  return Array.from({ length: count }, () => ({
    kind: kinds[Math.floor(random() * kinds.length)]!,
    model: random() < 0.5 ? 'Alpha' : 'Beta',
    bucket: String(Math.floor(random() * 3))
  }));
};

const stateOf = (fixture: ReturnType<typeof createInvariantFixture>) => ({
  alpha: fixture.models.Alpha.getAll().map(row => (row as { id: string }).id).sort(),
  beta: fixture.models.Beta.getAll().map(row => (row as { id: string }).id).sort(),
  bytes: storageByteSize(fixture.storage.storage)
});

const assertCheapInvariants = (fixture: ReturnType<typeof createInvariantFixture>): void => {
  for (const model of Object.values(fixture.models)) {
    for (const key of fixture.storage.storage.keys(`dbl:scope:${model.modelId}:`)) {
      const value = JSON.parse(fixture.storage.storage.get(key)!) as { entries: Array<{ id: string }> };
      for (const entry of value.entries) expect(model.get(entry.id)).toBeDefined();
    }
  }
  for (const key of ['Alpha:operation:0', 'Beta:operation:0']) {
    expect(getOperationState().hasPending(key) && getOperationState().hasCommitted(key)).toBe(false);
  }
};

describe('seeded operation-sequence invariants', () => {
  it('P1-P5: preserves reachability, replay idempotence, parseability, and ledger consistency for seeds 1 through 20', async () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const operations = operationsFor(seed, 200);
      const fixture = createInvariantFixture();
      try {
        for (const operation of operations) {
          const Model = fixture.models[operation.model];
          if (operation.kind === 'page') Model.scopes.feed.__apply?.({ bucket: operation.bucket }, [{ id: `${operation.model}:page:${operation.bucket}`, bucket: operation.bucket, value: seed }], 'page');
          if (operation.kind === 'complete') Model.scopes.feed.__apply?.({ bucket: operation.bucket }, [{ id: `${operation.model}:complete:${operation.bucket}`, bucket: operation.bucket, value: seed }], 'complete');
          if (operation.kind === 'delta') Model.scopes.feed.__apply?.({ bucket: operation.bucket }, [{ id: `${operation.model}:delta:${operation.bucket}`, bucket: operation.bucket, value: seed }], 'delta');
          if (operation.kind === 'ingest') await fixture.driver.ingestEvents(operation.model, 1);
          if (operation.kind === 'optimisticCommit') await fixture.driver.optimistic(operation.model, 1, 'commit');
          if (operation.kind === 'optimisticRollback') await fixture.driver.optimistic(operation.model, 1, 'rollback');
          if (operation.kind === 'destroy') await fixture.driver.destroys(operation.model, 1);
          if (operation.kind === 'patch') {
            const row = Model.getAll()[0] as { id: string } | undefined;
            if (row) Model.patch(row.id, { value: seed });
          }
          if (operation.kind === 'restart') await fixture.driver.restart();
          if (operation.kind === 'collect') collectGarbage();
          if (operation.kind === 'clock') getOperationState().nextSequence(`${operation.model}:${operation.bucket}`, seed);
          collectGarbage();
          assertCheapInvariants(fixture);
        }

        const beforeRestart = stateOf(fixture);
        await fixture.driver.restart();
        expect(stateOf(fixture)).toEqual(beforeRestart);
        for (const key of fixture.storage.storage.keys('dbl:')) expect(() => JSON.parse(fixture.storage.storage.get(key)!)).not.toThrow();
        for (const model of Object.values(fixture.models)) {
          const roots = new Set(['0', '1', '2'].flatMap(bucket => model.scopes.feed.read({ bucket }).map(row => (row as { id: string }).id)));
          for (const row of model.getAll() as Array<{ id: string }>) expect(roots.has(row.id)).toBe(true);
        }
      } catch (error) {
        throw withSeedContext(seed, operations, error);
      }
    }
  }, 30000);
});
