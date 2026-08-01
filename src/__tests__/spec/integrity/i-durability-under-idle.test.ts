import { configureDb, defineModelRuntime, f, suspendDb } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

/**
 * A row exists because something DECLARED it, not because someone happens to be looking at it right
 * now. Nothing is mounted while the app sits in the background, so a sweep whose roots are mounted
 * readers reclaims the whole database - and the user returns to an app that lost their data.
 */
describe('durability under idle', () => {
  it('keeps rows that belong to a declared scope when the app suspends', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({}) });
    const scoped = defineModelRuntime({
      id: 'SpecDurableScoped',
      name: 'SpecDurableScoped',
      fields: { bucket: f.str(), body: f.str() },
      scopes: { byBucket: ({ by: { bucket: 'bucket' } }) }
    });
    scoped.insertMany([
      { id: 'row-1', bucket: 'a', body: 'first' },
      { id: 'row-2', bucket: 'a', body: 'second' }
    ]);

    suspendDb();

    expect(scoped.all().map(row => row.id)).toEqual(['row-1', 'row-2']);
  });

  it('keeps written rows when the app suspends with no reader mounted', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({}) });
    const rows = defineModelRuntime({ id: 'SpecDurableIdle', name: 'SpecDurableIdle', fields: { body: f.str() } });
    rows.insertMany([
      { id: 'row-1', body: 'first' },
      { id: 'row-2', body: 'second' }
    ]);

    suspendDb();

    expect(rows.all().map(row => row.id)).toEqual(['row-1', 'row-2']);
  });
});
