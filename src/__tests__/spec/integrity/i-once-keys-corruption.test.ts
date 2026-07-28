import { configureDb, defineModel, f } from '../../../index';
import { bootDb } from '../../../dsl/lifecycle';
import { DB_FORMAT_VERSION } from '../../../core/schemaManifest';
import { encodePersistence } from '../../../core/persistenceCodec';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

/**
 * Corrupt persisted once-keys silently lose the `once` mutation dedupe set: after a schema
 * cold reset every committed once-operation becomes replayable. Losing that protection must be
 * visible through data-loss diagnostics, matching the corrupt-row/tombstone/scope contract.
 */
describe('once-keys corruption diagnostics', () => {
  it('reports corrupt persisted once-keys as a data-loss event during the manifest cold reset', async () => {
    const storage = createMemoryPlane();
    storage.set([
      { key: 'dbl:ops-once', value: '{corrupt-json' },
      { key: 'dbl:manifest', value: encodePersistence({ formatVersion: DB_FORMAT_VERSION, schemaFingerprint: 'stale-fingerprint', dataVersion: null }) }
    ]);
    configureDb({ storage, transport: createMockTransport() });
    diagnostics().reset();
    defineModel({ id: 'SpecOnceKeysCorruption', name: 'SpecOnceKeysCorruption', fields: { label: f.str() } });

    await bootDb();

    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'corrupt-once-keys', model: '__operations__', count: 1 });
  });
});
