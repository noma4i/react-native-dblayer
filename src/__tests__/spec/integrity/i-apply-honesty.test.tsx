import { configureDb, defineModelRuntime, f, getApplyRuntime, createCommitEnvelope, compositeStorageKey } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

describe('apply honesty (D5): mid-plan throw', () => {
  it('rejects an incomplete plan before persistence and leaves every model unchanged', () => {
    const storage = createMemoryPlane();
    const onSyncError = jest.fn();
    configureDb({ storage, transport: createMockTransport(), defaults: { onSyncError } });
    diagnostics().reset();

    const rows = defineModelRuntime({
      id: 'ApplyHonestyD5',
      name: 'ApplyHonestyD5',
      fields: { label: f.str() }
    });
    rows.insert({ id: 'row-1', label: 'baseline' });
    getApplyRuntime().flushCacheSnapshots();
    expect(storage.get(compositeStorageKey('dbl:', 'row', rows.modelId, 'row-1'))).toBeDefined();

    expect(() =>
      getApplyRuntime().commit(createCommitEnvelope([
        { kind: 'upsert', model: rows.modelId, rows: [{ id: 'row-2', label: 'fresh' }] },
        { kind: 'upsert', model: 'MissingApplyHonestyTarget', rows: [{ id: 'row-1', label: 'updated' }] }
      ]))
    ).toThrow('No apply target registered for MissingApplyHonestyTarget');

    getApplyRuntime().flushCacheSnapshots();
    expect(storage.get(compositeStorageKey('dbl:', 'row', rows.modelId, 'row-2'))).toBeUndefined();
    expect(rows.find('row-2')).toBeUndefined();
    expect(diagnostics().snapshot().applyFailure).toBe(0);
    expect(onSyncError).not.toHaveBeenCalled();
  });
});
