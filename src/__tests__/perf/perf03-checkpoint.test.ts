import { createJournal } from '../../core/apply/journal';
import type { StoragePlane } from '../../core/planes/storagePlane';
import { flushPersistence, getApplyRuntime, configureDb } from '../../dsl/configure';
import { defineModel } from '../../dsl/defineModel';
import { f } from '../../schema/f';

type StorageLog = {
  plane: StoragePlane;
  batches: Array<Array<{ key: string; value: string | null }>>;
  setValue(key: string, value: string | null): void;
  clearBatches(): void;
};

const createLoggedStorage = (): StorageLog => {
  const values = new Map<string, string>();
  const batches: Array<Array<{ key: string; value: string | null }>> = [];
  const apply = (entries: Array<{ key: string; value: string | null }>): void => {
    batches.push(entries);
    for (const entry of entries) entry.value === null ? values.delete(entry.key) : values.set(entry.key, entry.value);
  };
  return {
    plane: {
      get: key => values.get(key),
      set: apply,
      keys: prefix => [...values.keys()].filter(key => key.startsWith(prefix))
    },
    batches,
    setValue: (key, value) => apply([{ key, value }]),
    clearBatches: () => { batches.length = 0; }
  };
};

const transport = { query: async () => ({ data: {} }), mutation: async () => ({ data: {} }) } as any;

const setup = (storage: StorageLog, maxPendingPlans = 3) => {
  configureDb({
    storage: storage.plane,
    transport,
    defaults: { persistence: { checkpointDelayMs: 50, maxPendingPlans } }
  });
  const alpha = defineModel({ id: 'checkpoint-alpha', name: 'CheckpointAlphaModel', fields: { value: f.num(), unreadCount: f.num() } });
  const beta = defineModel({ id: 'checkpoint-beta', name: 'CheckpointBetaModel', fields: { value: f.num(), unreadCount: f.num() } });
  return { alpha, beta };
};

describe('perf 03: checkpoint persistence', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('A. keeps a 1000-row model snapshot off the hot path', () => {
    const storage = createLoggedStorage();
    const { alpha } = setup(storage, 2_000);
    for (let index = 0; index < 1_000; index += 1) alpha.insertStored({ id: `seed-${index}`, value: index, unreadCount: 0 });
    flushPersistence();
    storage.clearBatches();

    alpha.insertStored({ id: 'hot-path', value: 1_000, unreadCount: 0 });

    expect(storage.batches).toHaveLength(2);
    expect(storage.batches.flatMap(batch => batch.map(entry => entry.key)).every(key => key.startsWith('dbl:journal:'))).toBe(true);
    expect(storage.batches.flatMap(batch => batch.map(entry => entry.key)).some(key => key.startsWith('dbl:row:') || key.startsWith('dbl:scope:'))).toBe(false);
  });

  it('B. coalesces two plans into one ordered checkpoint batch', () => {
    const storage = createLoggedStorage();
    const { alpha, beta } = setup(storage);
    alpha.insertStored({ id: 'alpha', value: 1, unreadCount: 0 });
    beta.insertStored({ id: 'beta', value: 2, unreadCount: 0 });
    storage.clearBatches();

    flushPersistence();

    const rowBatches = storage.batches.filter(batch => batch.some(entry => entry.key.startsWith('dbl:row:')));
    expect(rowBatches).toHaveLength(1);
    const keys = rowBatches[0].map(entry => entry.key);
    for (const model of ['checkpoint-alpha', 'checkpoint-beta']) {
      expect(keys.indexOf(`dbl:applied:${model}`)).toBeGreaterThan(keys.findIndex(key => key.startsWith(`dbl:row:${model}:`)));
    }
    expect(keys.at(-1)).toBe('dbl:meta');
  });

  it('C. debounces a checkpoint flush for fifty milliseconds', () => {
    jest.useFakeTimers();
    const storage = createLoggedStorage();
    const { alpha } = setup(storage);
    alpha.insertStored({ id: 'debounce', value: 1, unreadCount: 0 });
    expect(storage.batches).toHaveLength(2);

    jest.advanceTimersByTime(50);

    expect(storage.batches).toHaveLength(3);
    expect(storage.batches[2].some(entry => entry.key === 'dbl:meta')).toBe(true);
  });

  it('D. flushes immediately when the pending-plan cap is reached', () => {
    jest.useFakeTimers();
    const storage = createLoggedStorage();
    const { alpha } = setup(storage);
    alpha.insertStored({ id: 'one', value: 1, unreadCount: 0 });
    alpha.insertStored({ id: 'two', value: 2, unreadCount: 0 });
    expect(storage.batches).toHaveLength(4);

    alpha.insertStored({ id: 'three', value: 3, unreadCount: 0 });

    expect(storage.batches).toHaveLength(7);
    expect(storage.batches[6].some(entry => entry.key.startsWith('dbl:row:'))).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('E. replays unflushed plans once after a restart', () => {
    const storage = createLoggedStorage();
    const first = setup(storage, 100);
    const runtime = getApplyRuntime();
    runtime.apply([{ kind: 'upsert', model: 'checkpoint-alpha', rows: [{ id: 'chat', value: 1, unreadCount: 0 }] }]);
    runtime.apply([{ kind: 'upsert', model: 'checkpoint-beta', rows: [{ id: 'message-1', value: 1, unreadCount: 0 }] }, { kind: 'counter', model: 'checkpoint-alpha', id: 'chat', field: 'unreadCount', delta: 1 }]);
    runtime.apply([{ kind: 'upsert', model: 'checkpoint-beta', rows: [{ id: 'message-2', value: 2, unreadCount: 0 }] }, { kind: 'counter', model: 'checkpoint-alpha', id: 'chat', field: 'unreadCount', delta: 1 }]);

    const restarted = setup(storage, 100);
    expect(getApplyRuntime().replay()).toBe(3);

    expect(restarted.alpha.get('chat')).toMatchObject({ value: 1, unreadCount: 2 });
    expect(restarted.beta.getAll().map((row: { id: string }) => row.id).sort()).toEqual(['message-1', 'message-2']);
  });

  it('F. replays only the model whose checkpoint marker was torn', () => {
    const storage = createLoggedStorage();
    const first = setup(storage, 100);
    getApplyRuntime().apply([
      { kind: 'upsert', model: 'checkpoint-alpha', rows: [{ id: 'alpha', value: 1, unreadCount: 0 }] },
      { kind: 'counter', model: 'checkpoint-alpha', id: 'alpha', field: 'unreadCount', delta: 1 },
      { kind: 'upsert', model: 'checkpoint-beta', rows: [{ id: 'beta', value: 2, unreadCount: 0 }] },
      { kind: 'counter', model: 'checkpoint-beta', id: 'beta', field: 'unreadCount', delta: 1 }
    ]);
    flushPersistence();
    storage.setValue('dbl:meta', null);
    storage.setValue('dbl:applied:checkpoint-alpha', null);

    const restarted = setup(storage, 100);
    expect(getApplyRuntime().replay()).toBe(1);
    expect(restarted.alpha.get('alpha')?.unreadCount).toBe(1);
    expect(restarted.beta.get('beta')?.unreadCount).toBe(1);
    expect(first.alpha.get('alpha')?.unreadCount).toBe(1);
  });

  it('G. prunes committed records immediately after a flushed checkpoint', () => {
    const storage = createLoggedStorage();
    const { alpha } = setup(storage, 100);
    for (let index = 0; index < 51; index += 1) alpha.insertStored({ id: `journal-${index}`, value: index, unreadCount: 0 });
    const journal = createJournal(storage.plane, () => 'dbl:');
    expect(journal.allRecords()).toHaveLength(51);

    flushPersistence();
    expect(journal.allRecords()).toHaveLength(50);
    alpha.insertStored({ id: 'journal-51', value: 51, unreadCount: 0 });

    expect(journal.allRecords()).toHaveLength(50);
  });
});
