import { collectGarbage } from '../../core/gc';
import { replayJournal } from '../../dsl/configure';
import { defineModel } from '../../dsl/defineModel';
import { scope } from '../../dsl/scope';
import { f } from '../../schema/f';
import { resetRuntime } from '../../index';
import { createContractScenario } from '../helpers/contractScenario';
import { createMemoryStorage } from '../helpers/memoryStorage';
import { createInvariantFixture, rowCount, runSession, scopeKeyCount, storageByteSize, storageKeyCount } from './session.helpers';

const session = [
  { kind: 'pages' as const, model: 'Alpha', scope: { bucket: '0' }, count: 5, rowsPerPage: 20 },
  { kind: 'pages' as const, model: 'Alpha', scope: { bucket: '1' }, count: 5, rowsPerPage: 20 },
  { kind: 'pages' as const, model: 'Beta', scope: { bucket: '0' }, count: 5, rowsPerPage: 20 },
  { kind: 'ingestEvents' as const, model: 'Alpha', count: 40 },
  { kind: 'ingestEvents' as const, model: 'Beta', count: 40 },
  { kind: 'optimistic' as const, model: 'Alpha', count: 4, outcome: 'commit' as const }
];

describe('steady-state invariants', () => {
  it('S1: identical sessions reach a storage, row, and scope fixpoint after restart', async () => {
    const fixture = createInvariantFixture();
    await runSession(fixture.driver, session);
    fixture.flushAndCollect();
    const first = {
      bytes: storageByteSize(fixture.storage.storage),
      keys: storageKeyCount(fixture.storage.storage),
      alphaRows: rowCount(fixture.models.Alpha),
      betaRows: rowCount(fixture.models.Beta),
      alphaScopes: scopeKeyCount(fixture.storage.storage, fixture.models.Alpha),
      betaScopes: scopeKeyCount(fixture.storage.storage, fixture.models.Beta)
    };

    await fixture.driver.restart();
    await runSession(fixture.driver, session);
    fixture.flushAndCollect();
    const second = {
      bytes: storageByteSize(fixture.storage.storage),
      keys: storageKeyCount(fixture.storage.storage),
      alphaRows: rowCount(fixture.models.Alpha),
      betaRows: rowCount(fixture.models.Beta),
      alphaScopes: scopeKeyCount(fixture.storage.storage, fixture.models.Alpha),
      betaScopes: scopeKeyCount(fixture.storage.storage, fixture.models.Beta)
    };

    expect(second.alphaRows).toBe(first.alphaRows);
    expect(second.betaRows).toBe(first.betaRows);
    expect(second.alphaScopes).toBe(first.alphaScopes);
    expect(second.betaScopes).toBe(first.betaScopes);
    expect(second.keys).toBe(first.keys);
    expect(second.bytes).toBeLessThanOrEqual(first.bytes);
  });

  it('S2: crash replay is lossless and replay cycles do not amplify journal storage', () => {
    const memory = createMemoryStorage();
    createContractScenario({ storage: memory, persistence: { checkpointDelayMs: 100000, maxPendingPlans: 100000 } });
    const Model = defineModel({ id: 'SteadyCrash', name: 'SteadyCrash', fields: { bucket: f.str() }, scopes: { feed: scope({}) } });
    Model.scopes.feed.__apply?.({}, [{ id: 'one', bucket: '0' }, { id: 'two', bucket: '0' }], 'complete');
    const before = { rows: Model.getAll().length, scope: Model.scopes.feed.read({}).length };
    const bytesBeforeReplay = storageByteSize(memory.storage);

    expect(replayJournal()).toBeGreaterThanOrEqual(0);
    const afterFirstReplay = storageByteSize(memory.storage);
    replayJournal();
    replayJournal();

    expect({ rows: Model.getAll().length, scope: Model.scopes.feed.read({}).length }).toEqual(before);
    expect(storageByteSize(memory.storage)).toBe(afterFirstReplay);
    expect(afterFirstReplay).toBeGreaterThanOrEqual(bytesBeforeReplay);
  });

  it('S3: logout clears the prefix and a fresh session matches a virgin store', async () => {
    const fixture = createInvariantFixture();
    await runSession(fixture.driver, session);
    fixture.flushAndCollect();
    resetRuntime();

    expect(storageKeyCount(fixture.storage.storage)).toBe(0);
    await runSession(fixture.driver, session);
    fixture.flushAndCollect();
    const afterResetEntries = Object.fromEntries(fixture.storage.storage.keys('dbl:').map(key => [key, fixture.storage.storage.get(key)]));
    const virgin = createInvariantFixture();
    await runSession(virgin.driver, session);
    virgin.flushAndCollect();

    const virginEntries = Object.fromEntries(virgin.storage.storage.keys('dbl:').map(key => [key, virgin.storage.storage.get(key)]));
    expect(Object.keys(afterResetEntries)).toEqual(Object.keys(virginEntries));
    for (const key of Object.keys(virginEntries)) {
      if (key === 'dbl:ops') continue; // createdAt is independently sampled wall-clock metadata.
      expect(afterResetEntries[key]).toBe(virginEntries[key]);
    }
    expect(afterResetEntries['dbl:ops']).toHaveLength(virginEntries['dbl:ops']!.length);
    collectGarbage();
  });
});
