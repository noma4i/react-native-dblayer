import {
  DB_FORMAT_VERSION,
  computeSchemaFingerprints,
  configureDb,
  encodePersistence,
  reconcilePersistence,
  readCommittedOnceKeys,
  resetRuntime,
  writePersistenceManifest
} from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

afterEach(resetRuntime);

describe('interrupted namespace reset recovery', () => {
  it('finishes a durable reset intent before accepting a compatible manifest', () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport(), defaults: {} });
    writePersistenceManifest('dbl:', {
      formatVersion: DB_FORMAT_VERSION,
      schemaFingerprints: computeSchemaFingerprints(),
      dataVersion: null
    });
    storage.set('dbl:row:InterruptedResetRows:stale', encodePersistence({ id: 'stale' }));
    storage.set('dbl:reset-intent', encodePersistence({ recordVersion: 1 }));

    expect(reconcilePersistence()).toEqual({ reset: true });
    expect(storage.snapshotKeys()).toEqual(['dbl:manifest']);
  });

  it('restores compatibility metadata carried by an interrupted reset intent', () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport(), defaults: {} });
    const manifest = {
      formatVersion: DB_FORMAT_VERSION,
      schemaFingerprints: computeSchemaFingerprints(),
      dataVersion: null
    };
    const operations = encodePersistence({
      recordVersion: 2,
      operations: {},
      committedKeys: ['PaymentRows:charge:payment-1']
    });
    storage.set('dbl:stale', 'present');
    storage.set(
      'dbl:reset-intent',
      encodePersistence({
        recordVersion: 1,
        restore: [
          { key: 'dbl:manifest', value: encodePersistence(manifest) },
          { key: 'dbl:ops', value: operations }
        ]
      })
    );

    expect(reconcilePersistence()).toEqual({ reset: true });
    expect(readCommittedOnceKeys(storage, 'dbl:').keys).toEqual(['PaymentRows:charge:payment-1']);
    expect(storage.snapshotKeys()).toEqual(['dbl:manifest', 'dbl:ops']);
  });
});
