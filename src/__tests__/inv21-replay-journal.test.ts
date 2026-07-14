describe('inv21: journal replay after restart', () => {
  it('replays plans applied after the last checkpoint flush', async () => {
    const backing = new Map<string, string>();
    const storage = {
      get: (key: string) => backing.get(key),
      set: (entries: Array<{ key: string; value: string | null }>) => {
        for (const entry of entries) {
          if (entry.value === null) backing.delete(entry.key);
          else backing.set(entry.key, entry.value);
        }
      },
      keys: (prefix: string) => [...backing.keys()].filter(key => key.startsWith(prefix))
    };
    const boot = async () => {
      jest.resetModules();
      const configureModule = await import('../dsl/configure');
      const modelModule = await import('../dsl/defineModel');
      const schemaModule = await import('../schema/f');
      configureModule.configureDb({
        transport: { query: async <TData>() => ({ data: {} as TData }), mutation: async <TData>() => ({ data: {} as TData }) },
        storage,
        defaults: { persistence: { checkpointDelayMs: 100000, maxPendingPlans: 100000 } }
      });
      const Model = modelModule.defineModel({ id: 'ReplayProbe', name: 'ReplayProbe', fields: { title: schemaModule.f.str() } });
      return { Model, replayJournal: configureModule.replayJournal };
    };

    const first = await boot();
    first.Model.insertStored({ id: 'r1', title: 'unflushed' });
    expect(first.Model.get('r1')).toBeDefined();

    const second = await boot();
    expect(second.Model.get('r1')).toBeUndefined();
    const replayed = second.replayJournal();
    expect(replayed).toBeGreaterThan(0);
    expect(second.Model.get('r1')).toEqual({ id: 'r1', title: 'unflushed' });
  });
});
