import { configureDb, defineModelRuntime, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

const refusingStorage = () => {
  const storage = createMemoryPlane();
  const accept = storage.set;
  let refusing = false;
  storage.set = (key, value) => {
    if (refusing) throw new Error('storage is full');
    accept(key, value);
  };
  return { storage, refuse: () => (refusing = true), allow: () => (refusing = false) };
};

/**
 * Storage that cannot take the write is the one moment where the tempting answer is to drop
 * something to make room. It is also the moment where dropping is least recoverable, so the write
 * fails loudly instead and the caller keeps what it has. A write reported as applied while storage
 * refused it would survive on screen until the next restart and then be gone, which reads to the
 * user exactly like data vanishing on its own.
 */
describe('storage refusal', () => {
  it('fails the write instead of applying it, and materializes nothing', () => {
    const { storage, refuse, allow } = refusingStorage();
    configureDb({ storage, transport: createMockTransport() });
    const rows = defineModelRuntime({ id: 'StorageRefusalInsert', name: 'StorageRefusalInsert', fields: { name: f.str() } });
    refuse();

    expect(() => rows.insert({ id: 'row-1', name: 'first' })).toThrow('storage is full');
    expect(rows.find('row-1')).toBeUndefined();
    allow();
  });

  it('keeps rows that were already durable when a later write is refused', () => {
    const { storage, refuse, allow } = refusingStorage();
    configureDb({ storage, transport: createMockTransport() });
    const rows = defineModelRuntime({ id: 'StorageRefusalKeep', name: 'StorageRefusalKeep', fields: { name: f.str() } });
    rows.insert({ id: 'row-1', name: 'first' });
    diagnostics().reset();
    refuse();

    expect(() => rows.insert({ id: 'row-2', name: 'second' })).toThrow('storage is full');

    // Making room is never the answer: the refusal costs the new row, never an old one, and the
    // refused row must not be sitting in memory as if it had been stored.
    expect(rows.all().map(row => row.id)).toEqual(['row-1']);
    expect(rows.find('row-1')).toMatchObject({ name: 'first' });
    expect(diagnostics().snapshot().dataLossEvents).toEqual([]);
    allow();
  });
});
