import { act } from 'react';
import { belongsTo, configureDb, defineModel, f, hasMany } from '../../../index';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

const document = { kind: 'Document', definitions: [] } as never;

type ItemRow = { id: string; parentId: string };
type ParentRow = { id: string; itemCount: number };

const createModels = (suffix: string) => {
  const parents = defineModel({
    id: `SpecIntegrityReplaceSymmetryParents${suffix}`,
    name: `SpecIntegrityReplaceSymmetryParents${suffix}`,
    fields: { id: f.str(), itemCount: f.num() }
  });
  const items = defineModel({
    id: `SpecIntegrityReplaceSymmetryItems${suffix}`,
    name: `SpecIntegrityReplaceSymmetryItems${suffix}`,
    fields: { id: f.str(), parentId: f.str() },
    maintenance: { dropTempRowsAfterMs: 1000 },
    scopes: { byParent: ({ by: { parentId: 'parentId' } }) },
    relations: () => ({
      parent: belongsTo<ItemRow, ParentRow>(parents, { foreignKey: 'parentId', counterCache: { field: 'itemCount' } })
    })
  });
  return { parents, items };
};

describe('replace relation effects', () => {
  it('E1 keeps a parent counter stable through an optimistic mutation commit identity swap', async () => {
    const transport = createMockTransport({ mutation: async <TData,>() => ({ data: { send: { item: { id: 'server-1', parentId: 'p-1' } } } as TData }) });
    configureDb({ storage: createMemoryPlane(), transport });
    const { parents, items } = createModels('MutationCommit');
    parents.insert({ id: 'p-1', itemCount: 0 });
    items.insert({ id: 'temp-1', parentId: 'p-1' });
    expect(parents.find('p-1')).toMatchObject({ itemCount: 1 });
    const send = items.mutation('send', {
      document,
      result: 'send',
      optimistic: {
        model: items,
        build: () => ({ id: 'unused', parentId: 'p-1' }),
        existingTempId: () => 'temp-1',
        selectServerNode: (data: { send: { item: ItemRow } }) => data.send.item
      }
    });

    await act(async () => {
      await send.run({});
    });

    expect(items.find('server-1')).toBeDefined();
    expect(parents.find('p-1')).toMatchObject({ itemCount: 1 });
  });

  it('E2 does not cascade a child destroy from the destroy half of a parent identity swap', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const parents = defineModel({
      id: 'SpecIntegrityReplaceSymmetryCascadeParents',
      name: 'SpecIntegrityReplaceSymmetryCascadeParents',
      fields: { id: f.str() },
      relations: () => ({ items: hasMany<ParentRow, ItemRow>(items, { foreignKey: 'parentId', dependent: 'destroy' }) })
    });
    const items = defineModel({
      id: 'SpecIntegrityReplaceSymmetryCascadeItems',
      name: 'SpecIntegrityReplaceSymmetryCascadeItems',
      fields: { id: f.str(), parentId: f.str() }
    });
    parents.insert({ id: 'temp-parent' } as never);
    items.insert({ id: 'child-1', parentId: 'temp-parent' });

    parents.replace('temp-parent', { id: 'server-parent' } as never);

    expect(items.find('child-1')).toBeDefined();
  });

  it('E3 applies ordinary destroy effects but not snapshot insert effects', async () => {
    const transport = createMockTransport({ query: async <TData,>() => ({ data: { rows: [{ id: 'snapshot-1', parentId: 'p-1' }] } as TData }) });
    configureDb({ storage: createMemoryPlane(), transport });
    const { parents, items } = createModels('Controls');
    parents.insert({ id: 'p-1', itemCount: 0 });
    items.insert({ id: 'event-1', parentId: 'p-1' });
    expect(parents.find('p-1')).toMatchObject({ itemCount: 1 });

    const snapshot = items.query<{ rows: ItemRow[] }, void, Record<string, never>, ItemRow>('snapshot', {
      document,
      select: data => data.rows,
      into: items
    });
    await snapshot.fetch({});
    expect(parents.find('p-1')).toMatchObject({ itemCount: 1 });

    items.destroy('event-1');
    expect(parents.find('p-1')).toMatchObject({ itemCount: 0 });
  });
});
