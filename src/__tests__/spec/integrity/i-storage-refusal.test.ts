import { configureDb, defineModelRuntime, f, getApplyRuntime } from '../../testApi';
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
 * something to make room. Making room is never the answer: a refused CACHE snapshot keeps its
 * model dirty and retries on the next flush, and a refused LEDGER write fails the commit loudly
 * (see the fault-harness ledger contracts). Nothing already durable is ever sacrificed.
 */
describe('storage refusal', () => {
  it('keeps the row in memory and lands it once storage accepts again', () => {
    const { storage, refuse, allow } = refusingStorage();
    configureDb({ storage, transport: createMockTransport() });
    const rows = defineModelRuntime({ id: 'StorageRefusalInsert', name: 'StorageRefusalInsert', fields: { name: f.str() } });
    refuse();

    rows.insert({ id: 'row-1', name: 'first' });
    expect(rows.find('row-1')).toMatchObject({ name: 'first' });
    expect(() => getApplyRuntime().flushCacheSnapshots()).toThrow('storage is full');

    allow();
    getApplyRuntime().flushCacheSnapshots();
    expect(storage.keys('dbl:row:').length).toBeGreaterThan(0);
  });

  it('keeps rows that were already durable when a later flush is refused', () => {
    const { storage, refuse, allow } = refusingStorage();
    configureDb({ storage, transport: createMockTransport() });
    const rows = defineModelRuntime({ id: 'StorageRefusalKeep', name: 'StorageRefusalKeep', fields: { name: f.str() } });
    rows.insert({ id: 'row-1', name: 'first' });
    getApplyRuntime().flushCacheSnapshots();
    diagnostics().reset();
    refuse();

    rows.insert({ id: 'row-2', name: 'second' });
    expect(() => getApplyRuntime().flushCacheSnapshots()).toThrow('storage is full');

    // The refusal delays the new row; it never costs an old one and never reports loss.
    expect(rows.all().map(row => row.id).sort()).toEqual(['row-1', 'row-2']);
    expect(rows.find('row-1')).toMatchObject({ name: 'first' });
    expect(diagnostics().snapshot().dataLossEvents).toEqual([]);
    allow();
  });
});
