import { belongsTo, configureDb, createDbSubscriptionRuntime, defineModelRuntime, f } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

describe('identity integrity red-first', () => {
  beforeEach(() => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
  });

  it('rejects a duplicate model id before it can replace an apply target', () => {
    defineModelRuntime({ id: 'IdentityDuplicateId', name: 'IdentityFirst', fields: { body: f.str() } });

    expect(() => defineModelRuntime({ id: 'IdentityDuplicateId', name: 'IdentitySecond', fields: { body: f.str() } })).toThrow('IdentityDuplicateId');
  });

  it('rejects a duplicate model name before ingest can route to the wrong model', () => {
    defineModelRuntime({ id: 'IdentityIngestFirst', name: 'IdentityDuplicateName', fields: { body: f.str() } });

    expect(() => defineModelRuntime({ id: 'IdentityIngestSecond', name: 'IdentityDuplicateName', fields: { body: f.str() } })).toThrow('IdentityDuplicateName');
  });

  it('rejects a duplicate subscription key', () => {
    expect(() => createDbSubscriptionRuntime([
      { key: 'identity-duplicate-subscription', query: {} as never, onData: () => undefined },
      { key: 'identity-duplicate-subscription', query: {} as never, onData: () => undefined }
    ])).toThrow('identity-duplicate-subscription');
  });

  it('aliases counter snapshots when template key segments contain colons', () => {
    const first = defineModelRuntime({ id: 'a:b', name: 'IdentityCounterFirst', fields: { count: f.num() } });
    const second = defineModelRuntime({ id: 'a', name: 'IdentityCounterSecond', fields: { count: f.num() } });
    const children = defineModelRuntime({
      id: 'IdentityCounterChild',
      name: 'IdentityCounterChild',
      fields: { firstId: f.str(), secondId: f.str() },
      relations: () => ({
        first: belongsTo(first, { foreignKey: 'firstId', counterCache: { field: 'count' } }),
        second: belongsTo(second, { foreignKey: 'secondId', counterCache: { field: 'count' } })
      })
    });
    first.insert({ id: 'c', count: 0 });
    second.insert({ id: 'b:c', count: 10 });
    children.insert({ id: 'identity-counter-child', firstId: 'c', secondId: 'b:c' });

    expect(second.find('b:c')?.count).toBe(11);
  });

  it('normalizes a numeric id before core row lookup', () => {
    const rows = defineModelRuntime({ id: 'IdentityNumericId', name: 'IdentityNumericId', fields: { body: f.str() } });
    rows.insert({ id: 1, body: 'number' } as never);

    expect(rows.find('1')?.body).toBe('number');
  });
});
