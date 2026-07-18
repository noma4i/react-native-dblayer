import { act } from 'react-test-renderer';
import { defineModel, f, resetRuntime } from '../../index';
import { renderCounted, setupAcceptanceRuntime } from './harness';

const burstRows = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, title: `t${index}` }));

describe('A22 in-session GC scheduler', () => {
  it('evicts unreachable rows after pressure and debounce', () => {
    jest.useFakeTimers();
    try {
      setupAcceptanceRuntime();
      const model = defineModel({ id: 'A22Evict', name: 'A22Evict', fields: { title: f.str() } });

      // Pressure source: 600 rows created then destroyed - well past the default threshold (500).
      const burst = burstRows('burst', 600);
      model.insertStoredMany(burst);

      // Orphan: unscoped, unreferenced, unrooted - only an actual collectGarbage() sweep removes it.
      model.insertStored({ id: 'orphan', title: 'orphan' });

      // Rooted: equally unscoped/unreferenced, but kept alive by a mounted use.row reader.
      model.insertStored({ id: 'rooted', title: 'rooted' });
      const reader = renderCounted(() => model.use.row('rooted'));

      act(() => {
        model.destroyMany(burst.map(row => row.id));
      });
      expect(model.get('orphan')).toBeDefined();

      act(() => {
        jest.advanceTimersByTime(1000);
      });

      expect(model.get('orphan')).toBeUndefined();
      expect(model.get('rooted')).toMatchObject({ id: 'rooted', title: 'rooted' });
      expect(reader.result()).toMatchObject({ id: 'rooted', title: 'rooted' });
      reader.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  it('stays quiet below threshold', () => {
    jest.useFakeTimers();
    try {
      setupAcceptanceRuntime();
      const model = defineModel({ id: 'A22Quiet', name: 'A22Quiet', fields: { title: f.str() } });
      model.insertStored({ id: 'orphan', title: 'orphan' });

      const rows = burstRows('row', 100);
      model.insertStoredMany(rows);
      model.destroyMany(rows.map(row => row.id));

      jest.advanceTimersByTime(60_000);

      expect(model.get('orphan')).toBeDefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('single sweep per window and pressure resets', () => {
    jest.useFakeTimers();
    try {
      setupAcceptanceRuntime();
      const model = defineModel({ id: 'A22Reset', name: 'A22Reset', fields: { title: f.str() } });
      model.insertStored({ id: 'orphan-a', title: 'orphan-a' });

      const first = burstRows('first', 600);
      model.insertStoredMany(first);
      model.destroyMany(first.map(row => row.id));
      jest.advanceTimersByTime(1000);
      expect(model.get('orphan-a')).toBeUndefined();

      model.insertStored({ id: 'orphan-b', title: 'orphan-b' });
      const second = burstRows('second', 100);
      model.insertStoredMany(second);
      model.destroyMany(second.map(row => row.id));
      jest.advanceTimersByTime(60_000);

      expect(model.get('orphan-b')).toBeDefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('maintenance batches do not self-trigger', () => {
    jest.useFakeTimers();
    try {
      setupAcceptanceRuntime();
      const model = defineModel({ id: 'A22SelfTrigger', name: 'A22SelfTrigger', fields: { title: f.str() } });

      // 600 orphan rows: unscoped/unreferenced/unrooted, never destroyed - present only so the
      // sweep has something real to evict (a non-empty maintenance batch to test self-trigger against).
      const orphans = burstRows('orphan', 600);
      model.insertStoredMany(orphans);

      // Separate destroy-shaped pressure source that actually arms the sweep - bulk inserts alone
      // build no pressure since nothing has disappeared.
      const trigger = burstRows('trigger', 600);
      model.insertStoredMany(trigger);
      model.destroyMany(trigger.map(row => row.id));

      model.insertStored({ id: 'kept', title: 'kept' });
      const reader = renderCounted(() => model.use.row('kept'));

      act(() => {
        jest.advanceTimersByTime(1000);
      });
      expect(model.get(orphans[0]!.id)).toBeUndefined();
      expect(model.get('kept')).toBeDefined();
      const survivorsAfterFirstSweep = model.getAll().length;

      act(() => {
        jest.advanceTimersByTime(60_000);
      });

      expect(model.getAll().length).toBe(survivorsAfterFirstSweep);
      reader.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  it('resetRuntime cancels a pending trigger', () => {
    jest.useFakeTimers();
    try {
      setupAcceptanceRuntime();
      const model = defineModel({ id: 'A22ResetCancel', name: 'A22ResetCancel', fields: { title: f.str() } });
      const rows = burstRows('row', 600);
      model.insertStoredMany(rows);
      model.destroyMany(rows.map(row => row.id)); // destroy-shaped pressure - actually arms a pending timer

      resetRuntime();

      model.insertStored({ id: 'fresh', title: 'fresh' });
      act(() => {
        jest.advanceTimersByTime(60_000);
      });

      expect(model.get('fresh')).toBeDefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('inSessionGc: false disables the trigger', () => {
    jest.useFakeTimers();
    try {
      setupAcceptanceRuntime({ defaults: { inSessionGc: false } });
      const model = defineModel({ id: 'A22Disabled', name: 'A22Disabled', fields: { title: f.str() } });
      model.insertStored({ id: 'orphan', title: 'orphan' }); // unscoped, unreferenced, unrooted

      const rows = burstRows('row', 600);
      model.insertStoredMany(rows);
      model.destroyMany(rows.map(row => row.id)); // would normally cross the threshold and trigger a sweep

      act(() => {
        jest.advanceTimersByTime(60_000);
      });

      expect(model.get('orphan')).toBeDefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('bulk inserts build no pressure', () => {
    jest.useFakeTimers();
    try {
      setupAcceptanceRuntime();
      const model = defineModel({ id: 'A22BulkInsert', name: 'A22BulkInsert', fields: { title: f.str() } });
      model.insertStored({ id: 'orphan', title: 'orphan' }); // pre-seeded, unscoped, unreferenced, unrooted

      const rows = burstRows('row', 600);
      model.insertStoredMany(rows); // 600 fresh inserts, no destroys anywhere

      jest.advanceTimersByTime(60_000);

      expect(model.get('orphan')).toBeDefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves unrelated reader identity through a scheduled sweep', () => {
    jest.useFakeTimers();
    try {
      setupAcceptanceRuntime();
      const pressure = defineModel({ id: 'A22IdentityPressure', name: 'IdentityPressure', fields: { title: f.str() } });
      const unrelated = defineModel({ id: 'A22IdentityUnrelated', name: 'IdentityUnrelated', fields: { title: f.str() } });
      unrelated.insertStored({ id: 'kept', title: 'kept' });
      const reader = renderCounted(() => unrelated.use.row('kept'));
      const initial = reader.result();
      const renders = reader.renders();
      const rows = burstRows('pressure', 600);
      pressure.insertStoredMany(rows);
      pressure.destroyMany(rows.map(row => row.id));

      act(() => { jest.advanceTimersByTime(1000); });

      expect(reader.renders()).toBe(renders);
      expect(reader.result()).toBe(initial);
      reader.unmount();
    } finally {
      jest.useRealTimers();
    }
  });
});
