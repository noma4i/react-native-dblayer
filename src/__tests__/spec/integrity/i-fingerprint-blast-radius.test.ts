import { bootDb, compositeStorageKey, computeSchemaFingerprints, configureDb, defineModelRuntime, f, flushPersistence, writePersistenceManifest } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

/**
 * A declaration change must not cost a user their whole local database.
 *
 * The boot compatibility gate compares one fingerprint per declared model, so a field added to one
 * model clears only that model's owned data. This case measures the blast radius across a sibling model.
 */
const defineAlpha = (extra: Record<string, unknown>) =>
  defineModelRuntime({
    id: 'BlastAlpha',
    name: 'BlastAlpha',
    fields: { label: f.str(), ...extra },
    scopes: { all: { by: { label: 'label' } } }
  });

const defineBeta = () =>
  defineModelRuntime({
    id: 'BlastBeta',
    name: 'BlastBeta',
    fields: { label: f.str() },
    scopes: { all: { by: { label: 'label' } } }
  });

describe('schema fingerprint blast radius', () => {
  it('keeps an untouched model rows when a different model gains a field', async () => {
    const storage = createMemoryPlane();

    configureDb({ storage, transport: createMockTransport(), dataVersion: 'blast' });
    const alphaBefore = defineAlpha({});
    const betaBefore = defineBeta();
    await bootDb();
    alphaBefore.insert({ id: 'a-1', label: 'alpha' });
    betaBefore.insert({ id: 'b-1', label: 'beta' });
    flushPersistence();
    expect(storage.snapshotKeys().filter(key => key.includes('BlastBeta')).length).toBeGreaterThan(0);

    // The only change between the two runs: one extra field on Alpha. Beta is untouched.
    configureDb({ storage, transport: createMockTransport(), dataVersion: 'blast' });
    const alphaAfter = defineAlpha({ addedField: f.str().nullDefault() });
    const betaAfter = defineBeta();
    diagnostics().reset();
    const boot = await bootDb();

    // Beta declared nothing new, so Beta owes the user its row whatever Alpha did.
    expect({
      alpha: alphaAfter.find('a-1'),
      beta: betaAfter.find('b-1'),
      reset: boot.reset,
      manifestResets: diagnostics().snapshot().manifestResets,
      dataLossEvents: diagnostics().snapshot().dataLossEvents
    }).toEqual({
      alpha: undefined,
      beta: { id: 'b-1', label: 'beta' },
      reset: false,
      manifestResets: 0,
      dataLossEvents: [{ mechanism: 'schema-migration-reset', model: 'BlastAlpha', count: 1 }]
    });

    const firstDataLossEvents = diagnostics().snapshot().dataLossEvents;
    await expect(bootDb()).resolves.toMatchObject({ reset: false });
    expect(diagnostics().snapshot().dataLossEvents).toEqual(firstDataLossEvents);
  });

  it('keeps persisted rows when a new model is added', async () => {
    const storage = createMemoryPlane();

    configureDb({ storage, transport: createMockTransport(), dataVersion: 'added-model' });
    const betaBefore = defineBeta();
    await bootDb();
    betaBefore.insert({ id: 'b-added-1', label: 'beta' });
    flushPersistence();

    configureDb({ storage, transport: createMockTransport(), dataVersion: 'added-model' });
    const betaAfter = defineBeta();
    const added = defineModelRuntime({ id: 'BlastAdded', name: 'BlastAdded', fields: { label: f.str() } });
    diagnostics().reset();
    const boot = await bootDb();

    expect({
      beta: betaAfter.find('b-added-1'),
      added: added.find('missing'),
      reset: boot.reset,
      dataLossEvents: diagnostics().snapshot().dataLossEvents
    }).toEqual({
      beta: { id: 'b-added-1', label: 'beta' },
      added: undefined,
      reset: false,
      dataLossEvents: []
    });
  });

  it('clears persisted keys for a removed model while preserving a declared sibling', async () => {
    const storage = createMemoryPlane();
    const keptId = 'BlastRemovedKept';
    const removedId = 'BlastRemovedGone';

    configureDb({ storage, transport: createMockTransport(), dataVersion: 'removed-model' });
    const keptBefore = defineModelRuntime({ id: keptId, name: keptId, fields: { label: f.str() } });
    await bootDb();
    keptBefore.insert({ id: 'kept-1', label: 'kept' });
    flushPersistence();
    storage.set([{ key: compositeStorageKey('dbl:', 'row', removedId, 'removed-1'), value: 'stale' }]);

    configureDb({ storage, transport: createMockTransport(), dataVersion: 'removed-model' });
    const keptAfter = defineModelRuntime({ id: keptId, name: keptId, fields: { label: f.str() } });
    const keptFingerprint = computeSchemaFingerprints()[keptId];
    writePersistenceManifest('dbl:', {
      formatVersion: 8,
      schemaFingerprints: { [removedId]: 'stale-fingerprint', [keptId]: keptFingerprint },
      dataVersion: 'removed-model'
    });
    diagnostics().reset();
    const boot = await bootDb();

    expect({
      kept: keptAfter.find('kept-1'),
      removedKey: storage.get(compositeStorageKey('dbl:', 'row', removedId, 'removed-1')),
      reset: boot.reset,
      dataLossEvents: diagnostics().snapshot().dataLossEvents
    }).toEqual({
      kept: { id: 'kept-1', label: 'kept' },
      removedKey: undefined,
      reset: false,
      dataLossEvents: [{ mechanism: 'schema-migration-reset', model: removedId, count: 1 }]
    });
  });
});
