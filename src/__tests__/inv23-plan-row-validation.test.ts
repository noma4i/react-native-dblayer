import { configureDb } from '../dsl/configure';
import { defineModel } from '../dsl/defineModel';
import { scope } from '../dsl/scope';
import { f } from '../schema/f';

describe('inv23: plan row validation', () => {
  it('snapshot page with an invalid row applies the valid rows and does not throw', () => {
    const backing = new Map<string, string>();
    const errorLog = jest.fn();
    const debugLog = jest.fn();
    configureDb({
      transport: { query: async <TData>() => ({ data: {} as TData }), mutation: async <TData>() => ({ data: {} as TData }) },
      storage: {
        get: key => backing.get(key),
        set: entries => {
          for (const entry of entries) {
            if (entry.value === null) backing.delete(entry.key);
            else backing.set(entry.key, entry.value);
          }
        },
        keys: prefix => [...backing.keys()].filter(key => key.startsWith(prefix))
      },
      logger: { debug: debugLog, error: errorLog }
    });
    const Model = defineModel({ id: 'GuardProbe', name: 'GuardProbe', fields: { title: f.str() }, guard: input => (input as { ok?: boolean }).ok === true, scopes: { all: scope({}) } });

    expect(() => Model.__applyRows?.([{ id: 'good', ok: true, title: 'kept' }, { id: 'bad', ok: false, title: 'dropped' }])).not.toThrow();
    expect(Model.get('good')).toBeDefined();
    expect(Model.get('bad')).toBeUndefined();
    expect(errorLog).toHaveBeenCalled();
  });

  it('scope page with an id-less row keeps membership clean', () => {
    const backing = new Map<string, string>();
    const errorLog = jest.fn();
    const debugLog = jest.fn();
    configureDb({
      transport: { query: async <TData>() => ({ data: {} as TData }), mutation: async <TData>() => ({ data: {} as TData }) },
      storage: {
        get: key => backing.get(key),
        set: entries => {
          for (const entry of entries) {
            if (entry.value === null) backing.delete(entry.key);
            else backing.set(entry.key, entry.value);
          }
        },
        keys: prefix => [...backing.keys()].filter(key => key.startsWith(prefix))
      },
      logger: { debug: debugLog, error: errorLog }
    });
    const Model = defineModel({ id: 'GuardProbe', name: 'GuardProbe', fields: { title: f.str() }, guard: input => (input as { ok?: boolean }).ok === true, scopes: { all: scope({}) } });

    expect(() => Model.scopes.all.__apply?.({}, [{ id: 'ok1', ok: true, title: 'a' }, { ok: true, title: 'no-id' } as never], 'complete')).not.toThrow();
    expect(Model.scopes.all.read({}).map(row => (row as { id: string }).id)).toEqual(['ok1']);
  });

  it('event insert of a guard-rejected row is dropped at apply without breaking the plan', () => {
    const backing = new Map<string, string>();
    const errorLog = jest.fn();
    const debugLog = jest.fn();
    configureDb({
      transport: { query: async <TData>() => ({ data: {} as TData }), mutation: async <TData>() => ({ data: {} as TData }) },
      storage: {
        get: key => backing.get(key),
        set: entries => {
          for (const entry of entries) {
            if (entry.value === null) backing.delete(entry.key);
            else backing.set(entry.key, entry.value);
          }
        },
        keys: prefix => [...backing.keys()].filter(key => key.startsWith(prefix))
      },
      logger: { debug: debugLog, error: errorLog }
    });
    const Model = defineModel({ id: 'GuardProbe', name: 'GuardProbe', fields: { title: f.str() }, guard: input => (input as { ok?: boolean }).ok === true, scopes: { all: scope({}) } });

    expect(() => Model.insertStored({ id: 'evt-bad', ok: false, title: 'x' } as never)).not.toThrow();
    expect(Model.get('evt-bad')).toBeUndefined();
  });
});
