import { defineModel, f, flushPersistence } from '../../index';
import { createAcceptanceTransport, setupAcceptanceRuntime } from './harness';

const document = { kind: 'Document', definitions: [] } as never;

describe('A20 tombstone retention', () => {
  it('tombstone burst prunes past the min-age guard', async () => {
    const startedMs = Date.now();
    const transport = createAcceptanceTransport({
      query: async <TData,>() => ({
        data: {
          items: [
            { id: 'burst-0', title: 'stale-oldest' },
            { id: 'burst-20000', title: 'stale-newest' }
          ]
        } as TData
      })
    });
    setupAcceptanceRuntime({ transport });
    const model = defineModel({ id: 'A20Burst', name: 'A20Burst', fields: { title: f.str() } });
    const COUNT = 20001;
    const rows = Array.from({ length: COUNT }, (_, index) => ({ id: `burst-${index}`, title: `row-${index}` }));

    model.insertStoredMany(rows);
    model.destroyMany(rows.map(row => row.id));
    flushPersistence();

    const query = model.query('burst', {
      document,
      select: data => (data as { items: Array<{ id: string; title: string }> }).items,
      into: model
    });
    await query.fetch({});

    // Overflow valve prunes oldest-first straight to the cap, ignoring the min-age guard: the
    // first-destroyed id's tombstone is gone (a stale query write is now accepted), the
    // last-destroyed id survives among the newest TOMBSTONE_CAP entries (still gated).
    expect(model.get('burst-0')).toMatchObject({ id: 'burst-0', title: 'stale-oldest' });
    expect(model.get('burst-20000')).toBeUndefined();

    expect(Date.now() - startedMs).toBeLessThan(10_000);
  });

  it('quiescent model tombstones decay on flush', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-07-15T00:00:00.000Z'));
      const transport = createAcceptanceTransport({
        query: async <TData,>() => ({ data: { items: [{ id: 'row-1', title: 'stale' }] } as TData })
      });
      setupAcceptanceRuntime({ transport });
      const model = defineModel({ id: 'A20Quiescent', name: 'A20Quiescent', fields: { title: f.str() } });

      model.insertStored({ id: 'row-1', title: 'fresh' });
      model.destroy('row-1');
      flushPersistence();

      jest.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
      // No new writes to this model since the flush above - the fix under test is that the
      // checkpoint flush still runs pruneTombstones() for it instead of skipping quiescent models.
      flushPersistence();

      const query = model.query('resurrect', {
        document,
        select: data => (data as { items: Array<{ id: string; title: string }> }).items,
        into: model
      });
      await query.fetch({});

      expect(model.get('row-1')).toMatchObject({ id: 'row-1', title: 'stale' });
    } finally {
      jest.useRealTimers();
    }
  });
});
