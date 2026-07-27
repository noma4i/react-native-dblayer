import { createEngineAdapter } from '../../../engine/EngineAdapter';

const byCodepoint = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

describe('EngineAdapter', () => {
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
});
