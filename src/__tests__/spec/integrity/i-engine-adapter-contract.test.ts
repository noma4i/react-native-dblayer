import { createEngineAdapter, syncEngineBatch } from '../../../engine/EngineAdapter';

const byCodepoint = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const measureMembershipWritesForInsert = (size: number): { delta: number; rebuild: number } => {
  const model = `EngineWriteScale${size}`;
  const scopeKey = 'scope-1';
  const ids = Array.from({ length: size }, (_, index) => `row-${index}`);
  const rows = new Map(ids.map(id => [id, { id }]));
  const scopeIds = [...ids];
  const writes: Array<{ kind: 'delta' | 'rebuild'; count: number }> = [];
  const adapter = createEngineAdapter({
    onMembershipWrite: (kind, changes) => writes.push({ kind, count: changes.length })
  });
  const target = {
    readRow: (id: string) => rows.get(id),
    readAllRows: () => [...rows.values()],
    readScopeOrder: (key: string) => key === scopeKey ? scopeIds : [],
    readAllScopeKeys: () => [scopeKey],
    scopeOrderAffected: () => false
  };
  const resolveAdapter = () => adapter;

  syncEngineBatch({
    rows: ids.map(id => ({ model, id, fields: null })),
    scopes: [{ model, scopeKey }],
    scopeChanges: [{ model, scopeKey, rebuild: true }]
  }, () => target, true, resolveAdapter);
  writes.length = 0;

  const insertedId = 'row-inserted';
  rows.set(insertedId, { id: insertedId });
  scopeIds.splice(Math.floor(size / 2), 0, insertedId);
  syncEngineBatch({
    rows: [{ model, id: insertedId, fields: null }],
    scopes: [{ model, scopeKey }],
    scopeChanges: [{ model, scopeKey, appendIds: [insertedId], appendEntries: [{ id: insertedId, order: size / 2 }] }]
  }, () => target, false, resolveAdapter);

  return writes.reduce((totals, write) => ({
    ...totals,
    [write.kind]: totals[write.kind] + write.count
  }), { delta: 0, rebuild: 0 });
};

describe('EngineAdapter', () => {
  it('writes one delta membership for an inserted row at 300 and 3000 rows', () => {
    expect({ small: measureMembershipWritesForInsert(300), large: measureMembershipWritesForInsert(3000) }).toEqual({
      small: { delta: 1, rebuild: 0 },
      large: { delta: 1, rebuild: 0 }
    });
  });

  it('writes only the inserted membership when a delta lands in the middle', () => {
    const writes: Array<{ kind: 'delta' | 'rebuild'; changes: ReadonlyArray<{ type: string; value?: { entityId: string } }> }> = [];
    const adapter = createEngineAdapter({
      onMembershipWrite: (kind, changes) => writes.push({ kind, changes })
    });
    adapter.markReady();
    adapter.apply({
      entities: [
        { type: 'upsert', value: { id: 'first' } },
        { type: 'upsert', value: { id: 'last' } }
      ],
      memberships: []
    });
    adapter.replaceScope('scope-1', ['first', 'last']);
    writes.length = 0;

    adapter.apply({
      entities: [{ type: 'upsert', value: { id: 'middle' } }],
      memberships: [{ type: 'upsert', value: { scopeKey: 'scope-1', entityId: 'middle', orderKey: 'pending' } }],
      scopeOrder: ['first', 'middle', 'last']
    });

    expect(writes).toEqual([{ kind: 'delta', changes: [{ type: 'upsert', value: expect.objectContaining({ entityId: 'middle' }) }] }]);
    expect(adapter.readScope('scope-1')).toEqual(['first', 'middle', 'last']);
  });

  it('keeps 1000 inserts at one position in scope order without a rank rebuild', () => {
    const writes: Array<{ kind: 'delta' | 'rebuild'; count: number }> = [];
    const adapter = createEngineAdapter({
      onMembershipWrite: (kind, changes) => writes.push({ kind, count: changes.length })
    });
    const scopeIds = ['first', 'last'];
    adapter.markReady();
    adapter.apply({
      entities: scopeIds.map(id => ({ type: 'upsert' as const, value: { id } })),
      memberships: []
    });
    adapter.replaceScope('scope-1', scopeIds);
    writes.length = 0;

    for (let index = 0; index < 1000; index += 1) {
      const id = `middle-${index}`;
      scopeIds.splice(1, 0, id);
      adapter.apply({
        entities: [{ type: 'upsert', value: { id } }],
        memberships: [{ type: 'upsert', value: { scopeKey: 'scope-1', entityId: id, orderKey: 'pending' } }],
        scopeOrder: scopeIds
      });
    }

    expect(adapter.readScope('scope-1')).toEqual(scopeIds);
    expect(writes).toHaveLength(1000);
    expect(writes.every(write => write.kind === 'delta' && write.count === 1)).toBe(true);
  });

  it('keeps reads empty until replay is marked ready', () => {
    const adapter = createEngineAdapter();
    adapter.apply({
      entities: [{ type: 'upsert', value: { id: 'row-1', label: 'first' } }],
      memberships: [{ type: 'upsert', value: { scopeKey: 'scope-1', entityId: 'row-1', orderKey: 'a' } }]
    });

    expect(adapter.readEntity('row-1')).toBeUndefined();
    expect(adapter.readScope('scope-1')).toEqual([]);

    adapter.markReady();

    expect(adapter.readEntity('row-1')).toMatchObject({ id: 'row-1', label: 'first' });
    expect(adapter.readScope('scope-1')).toEqual(['row-1']);
  });

  it('confirms entities through sync before membership and compares order by code point', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const phases: Array<{ name: string; entity: boolean; members: string[] }> = [];
    const adapter = createEngineAdapter({
      onPhase: (name, current) => phases.push({ name, entity: current.readEntity('row-A') !== undefined, members: [...current.readScope('scope-1')] })
    });
    const keys = ['b', 'A', 'a', 'B', 'Ab', 'aB'];
    const codepoint = [...keys].sort(byCodepoint);

    expect(codepoint).not.toEqual([...keys].sort((left, right) => left.localeCompare(right)));

    adapter.markReady();
    adapter.apply({
      entities: keys.map(key => ({ type: 'upsert' as const, value: { id: `row-${key}`, key } })),
      memberships: keys.map(key => ({ type: 'upsert' as const, value: { scopeKey: 'scope-1', entityId: `row-${key}`, orderKey: key } }))
    });

    expect(phases).toContainEqual({ name: 'entities', entity: true, members: [] });
    expect(adapter.readScope('scope-1')).toEqual(codepoint.map(key => `row-${key}`));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('removes only the requested entity or membership through sync', () => {
    const adapter = createEngineAdapter();
    adapter.markReady();
    adapter.apply({
      entities: [
        { type: 'upsert', value: { id: 'row-1', label: 'first' } },
        { type: 'upsert', value: { id: 'row-2', label: 'second' } }
      ],
      memberships: [
        { type: 'upsert', value: { scopeKey: 'scope-1', entityId: 'row-1', orderKey: 'a' } },
        { type: 'upsert', value: { scopeKey: 'scope-1', entityId: 'row-2', orderKey: 'b' } }
      ]
    });

    adapter.apply({
      entities: [{ type: 'delete', id: 'row-1' }],
      memberships: [{ type: 'delete', scopeKey: 'scope-1', entityId: 'row-1' }]
    });

    expect(adapter.readEntity('row-1')).toBeUndefined();
    expect(adapter.readScope('scope-1')).toEqual(['row-2']);
  });

  it('reads only memberships selected by the scopeKey index', () => {
    const adapter = createEngineAdapter();
    adapter.markReady();
    adapter.apply({
      entities: [
        { type: 'upsert', value: { id: 'scope-1-row' } },
        { type: 'upsert', value: { id: 'scope-2-row' } }
      ],
      memberships: [
        { type: 'upsert', value: { scopeKey: 'scope-1', entityId: 'scope-1-row', orderKey: 'a' } },
        { type: 'upsert', value: { scopeKey: 'scope-2', entityId: 'scope-2-row', orderKey: 'a' } }
      ]
    });

    expect(adapter.readScope('scope-1')).toEqual(['scope-1-row']);
  });
});
