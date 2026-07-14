import { createEntityClock, createEntityState } from '../core/planes/entityState';
import { configureDb } from '../dsl/configure';
import { defineModel } from '../dsl/defineModel';
import { scope } from '../dsl/scope';
import { f } from '../schema/f';

describe('inv19: tombstone gate', () => {
  it('snapshot upsert does not resurrect a destroyed row; event upsert does', () => {
    const backing = new Map<string, string>();
    configureDb({
      transport: { query: async <TData>() => ({ data: {} as TData }), mutation: async <TData>() => ({ data: {} as TData }) },
      storage: {
        get: (key: string) => backing.get(key),
        set: (entries: Array<{ key: string; value: string | null }>) => {
          for (const entry of entries) {
            if (entry.value === null) backing.delete(entry.key);
            else backing.set(entry.key, entry.value);
          }
        },
        keys: (prefix: string) => [...backing.keys()].filter(key => key.startsWith(prefix))
      }
    });
    const Model = defineModel({ id: 'TombProbe', name: 'TombProbe', fields: { title: f.str() }, scopes: { all: scope({}) } });

    Model.insertStored({ id: 'a', title: 'first' });
    Model.destroy('a');
    Model.__applyRows?.([{ id: 'a', title: 'stale-page' }]);
    expect(Model.get('a')).toBeUndefined();

    Model.scopes.all.__apply?.({}, [{ id: 'a', title: 'stale-page' }], 'complete');
    expect(Model.get('a')).toBeUndefined();
    expect(Model.scopes.all.read({})).toEqual([]);

    Model.insertStored({ id: 'a', title: 'recreated' });
    expect(Model.get('a')).toEqual({ id: 'a', title: 'recreated' });

    Model.__applyRows?.([{ id: 'a', title: 'server-refresh' }]);
    expect(Model.get('a')).toEqual({ id: 'a', title: 'server-refresh' });
  });

  it('persistEntries prunes tombstones older than TTL', () => {
    let now = 0;
    const backing = new Map<string, string>();
    const state = createEntityState({
      modelId: 'p',
      clock: createEntityClock(),
      now: () => now,
      storage: {
        get: (key: string) => backing.get(key),
        set: (entries: Array<{ key: string; value: string | null }>) => {
          for (const entry of entries) {
            if (entry.value === null) backing.delete(entry.key);
            else backing.set(entry.key, entry.value);
          }
        },
        keys: (prefix: string) => [...backing.keys()].filter(key => key.startsWith(prefix))
      },
      prefix: () => 'dbl:test:'
    });
    state.upsert({ id: 'x' });
    state.destroy('x');
    now = 24 * 60 * 60 * 1000 + 1;
    const entries = state.persistEntries();
    const tombstones = JSON.parse(entries[1]!.value as string) as Record<string, unknown>;
    expect(Object.keys(tombstones)).toEqual([]);
    expect(state.isTombstoned('x')).toBe(false);
  });
});
