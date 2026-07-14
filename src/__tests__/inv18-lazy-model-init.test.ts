import { configureDb } from '../dsl/configure';
import { defineModel } from '../dsl/defineModel';
import { f } from '../schema/f';

describe('inv18: lazy model plane init', () => {
  it('defines a model before configureDb and reads hydrated rows after it', () => {
    const Model = defineModel({ id: 'LazyProbe', name: 'LazyProbe', fields: { title: f.str() } });

    const backing = new Map<string, string>();
    backing.set('dbl:rows:LazyProbe', JSON.stringify([{ id: 'seed', title: 'hydrated' }]));
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

    expect(Model.get('seed')).toEqual({ id: 'seed', title: 'hydrated' });
    Model.insertStored({ id: 'live', title: 'written' });
    expect(Model.get('live')).toEqual({ id: 'live', title: 'written' });
  });
});
