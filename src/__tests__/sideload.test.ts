import { configureDb, defineModel, devClearAllDataAndState } from '../index';
import { clearModelRegistry } from '../core/modelRegistry';
import { f } from '../schema/f';
import { installMemoryStorage, mockTransport } from './helpers/testRuntime';

const childFields = {
  name: f.str()
};

const parentFields = {
  title: f.str()
};

const createChildModel = (id: string, name = `SideloadChildModel:${id}`) =>
  defineModel({
    id,
    name,
    fields: childFields,
    merge: {}
  });

describe('model sideload runtime', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    devClearAllDataAndState();
    configureDb({ transport: mockTransport({}), modelDefaults: {} });
    clearModelRegistry();
  });

  it('writes plucked single objects and arrays into the target model', () => {
    installMemoryStorage();
    const childModel = createChildModel('sideload-child-basic', 'SideloadChildBasicModel');
    const parentModel = defineModel({
      id: 'sideload-parent-basic',
      name: 'SideloadParentBasicModel',
      fields: parentFields,
      sideload: [
        {
          model: 'SideloadChildBasicModel',
          pluck: input => (input as { child?: unknown }).child
        },
        {
          model: 'SideloadChildBasicModel',
          pluck: input => (input as { children?: unknown }).children
        }
      ],
      merge: {}
    });

    expect(
      parentModel.applyServerData(
        [
          {
            id: 'p1',
            title: 'Parent 1',
            child: { id: 'c1', name: 'Child 1' },
            children: [{ id: 'c2', name: 'Child 2' }, null]
          },
          {
            id: 'p2',
            title: 'Parent 2',
            child: null,
            children: [undefined, { id: 'c3', name: 'Child 3' }]
          }
        ],
        { mode: 'merge', source: 'parents' }
      )
    ).toEqual({ merged: 2 });

    expect(childModel.getAll().map(row => ({ id: row.id, name: row.name })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'c1', name: 'Child 1' },
      { id: 'c2', name: 'Child 2' },
      { id: 'c3', name: 'Child 3' }
    ]);
  });

  it('throws when the sideload target is missing from the registry', () => {
    installMemoryStorage();
    const parentModel = defineModel({
      id: 'sideload-missing-parent',
      name: 'SideloadMissingParentModel',
      fields: parentFields,
      sideload: [
        {
          model: 'MissingChildModel',
          pluck: input => (input as { child?: unknown }).child
        }
      ],
      merge: {}
    });

    expect(() => parentModel.applyServerData([{ id: 'p1', title: 'Parent', child: { id: 'c1', name: 'Child' } }], { mode: 'merge' })).toThrow(
      '[MissingChildModel] model is not registered. Registered models: SideloadMissingParentModel.'
    );
  });

  it('skips in-flight targets to prevent sideload cycles', () => {
    installMemoryStorage();
    const modelA = defineModel({
      id: 'sideload-cycle-a',
      name: 'SideloadCycleA',
      fields: {
        title: f.str()
      },
      sideload: [
        {
          model: 'SideloadCycleB',
          pluck: input => (input as { b?: unknown }).b
        }
      ],
      merge: {}
    });
    const modelB = defineModel({
      id: 'sideload-cycle-b',
      name: 'SideloadCycleB',
      fields: {
        title: f.str()
      },
      sideload: [
        {
          model: 'SideloadCycleA',
          pluck: input => (input as { a?: unknown }).a
        }
      ],
      merge: {}
    });

    expect(() =>
      modelA.applyServerData(
        [
          {
            id: 'a1',
            title: 'A1',
            b: {
              id: 'b1',
              title: 'B1',
              a: { id: 'a2', title: 'A2' }
            }
          }
        ],
        { mode: 'merge' }
      )
    ).not.toThrow();

    expect(modelA.getAll().map(row => row.id)).toEqual(['a1']);
    expect(modelB.getAll().map(row => row.id)).toEqual(['b1']);
  });

  it('propagates sideload source labels with the expected precedence', () => {
    installMemoryStorage();
    const explicitTarget = createChildModel('sideload-source-explicit', 'SideloadSourceExplicitTarget');
    const parentSourceTarget = createChildModel('sideload-source-parent', 'SideloadSourceParentTarget');
    const defaultTarget = createChildModel('sideload-source-default', 'SideloadSourceDefaultTarget');
    const explicitSpy = jest.spyOn(explicitTarget, 'applyServerData');
    const parentSourceSpy = jest.spyOn(parentSourceTarget, 'applyServerData');
    const defaultSpy = jest.spyOn(defaultTarget, 'applyServerData');

    const explicitParent = defineModel({
      id: 'sideload-source-explicit-parent',
      name: 'SideloadSourceExplicitParent',
      fields: parentFields,
      sideload: [
        {
          model: 'SideloadSourceExplicitTarget',
          source: 'explicit-source',
          pluck: input => (input as { child?: unknown }).child
        }
      ],
      merge: {}
    });
    const parentSourceParent = defineModel({
      id: 'sideload-source-parent-parent',
      name: 'SideloadSourceParentParent',
      fields: parentFields,
      sideload: [
        {
          model: 'SideloadSourceParentTarget',
          pluck: input => (input as { child?: unknown }).child
        }
      ],
      merge: {}
    });
    const defaultParent = defineModel({
      id: 'sideload-source-default-parent',
      name: 'SideloadSourceDefaultParent',
      fields: parentFields,
      sideload: [
        {
          model: 'SideloadSourceDefaultTarget',
          pluck: input => (input as { child?: unknown }).child
        }
      ],
      merge: {}
    });

    explicitParent.applyServerData([{ id: 'p1', title: 'Parent', child: { id: 'c1', name: 'Child' } }], { mode: 'merge', source: 'parent-source' });
    parentSourceParent.applyServerData([{ id: 'p2', title: 'Parent', child: { id: 'c2', name: 'Child' } }], { mode: 'merge', source: 'parent-source' });
    defaultParent.applyServerData([{ id: 'p3', title: 'Parent', child: { id: 'c3', name: 'Child' } }], { mode: 'merge' });

    expect(explicitSpy).toHaveBeenCalledWith([{ id: 'c1', name: 'Child' }], expect.objectContaining({ mode: 'merge', source: 'explicit-source' }));
    expect(parentSourceSpy).toHaveBeenCalledWith([{ id: 'c2', name: 'Child' }], expect.objectContaining({ mode: 'merge', source: 'parent-source' }));
    expect(defaultSpy).toHaveBeenCalledWith([{ id: 'c3', name: 'Child' }], expect.objectContaining({ mode: 'merge', source: 'sideload' }));
  });

  it('keeps parent merge dedupe independent from child sideloads', () => {
    installMemoryStorage();
    const childModel = createChildModel('sideload-dedupe-child', 'SideloadDedupeChildModel');
    const parentModel = defineModel({
      id: 'sideload-dedupe-parent',
      name: 'SideloadDedupeParentModel',
      fields: parentFields,
      sideload: [
        {
          model: 'SideloadDedupeChildModel',
          pluck: input => (input as { child?: unknown }).child
        }
      ],
      merge: {
        dedupeWindowMs: 1000
      }
    });
    jest.spyOn(Date, 'now').mockReturnValue(1000);
    const payload = [{ id: 'p1', title: 'Parent', child: { id: 'c1', name: 'Child' } }];

    expect(parentModel.applyServerData(payload, { mode: 'merge' })).toEqual({ merged: 1 });
    expect(parentModel.applyServerData(payload, { mode: 'merge' })).toEqual({ merged: 0 });

    expect(parentModel.getAll().map(row => row.id)).toEqual(['p1']);
    expect(childModel.getAll().map(row => ({ id: row.id, name: row.name }))).toEqual([{ id: 'c1', name: 'Child' }]);
  });

  it('supports sideload on legacy normalize models', () => {
    installMemoryStorage();
    const childModel = createChildModel('sideload-legacy-child', 'SideloadLegacyChildModel');
    const parentModel = defineModel<{ id: string; title: string; child?: unknown }, { id: string; title: string }>({
      id: 'sideload-legacy-parent',
      name: 'SideloadLegacyParentModel',
      normalize: input => ({ id: input.id, title: input.title }),
      sideload: [
        {
          model: 'SideloadLegacyChildModel',
          pluck: input => input.child
        }
      ],
      merge: {}
    });

    expect(parentModel.applyServerData([{ id: 'p1', title: 'Parent', child: { id: 'c1', name: 'Child' } }], { mode: 'merge' })).toEqual({ merged: 1 });

    expect(childModel.get('c1')).toMatchObject({ id: 'c1', name: 'Child' });
  });

  it('runs sideloads for replaceRaw replacement items', () => {
    installMemoryStorage();
    const childModel = createChildModel('sideload-replace-raw-child', 'SideloadReplaceRawChildModel');
    const parentModel = defineModel({
      id: 'sideload-replace-raw-parent',
      name: 'SideloadReplaceRawParentModel',
      fields: parentFields,
      sideload: [
        {
          model: 'SideloadReplaceRawChildModel',
          pluck: input => (input as { child?: unknown }).child
        }
      ],
      merge: {}
    });
    parentModel.insertStored({ id: 'temp-1', title: 'Temp' });

    expect(parentModel.replaceRaw('temp-1', { id: 'p1', title: 'Final', child: { id: 'c1', name: 'Child' } })).toBe(true);

    expect(parentModel.get('temp-1')).toBeUndefined();
    expect(parentModel.get('p1')).toMatchObject({ id: 'p1', title: 'Final' });
    expect(childModel.get('c1')).toMatchObject({ id: 'c1', name: 'Child' });
  });
});
