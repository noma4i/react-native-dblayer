import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { DbProvider, configureDb, defineModelRuntime, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, settle } from '../helpers/harness';

type Row = { id: string; name: string; group: string | null };
type Response = { rows: Row[] };

const document = { kind: 'Document', definitions: [] } as never;

const createRowsModel = (id: string) =>
  defineModelRuntime({
    id,
    name: id,
    fields: { name: f.str(), group: f.str().nullable() },
    scopes: { group: ({ by: { group: 'group' } }) }
  });

/**
 * Freshness tracks row survival, but a consumer reads scope membership. A row that stays alive while
 * losing its membership leaves the reader empty, so the query that owns that membership must stop
 * being fresh - otherwise the empty result is served forever.
 */
describe('freshness follows scope membership, not only row survival', () => {
  it('refetches a scope-destination query on remount after a complete snapshot detached its rows', async () => {
    let calls = 0;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ query: async <TData,>() => ({ data: { rows: [{ id: `detach-${++calls}`, name: 'Scoped', group: 'g' }] } as TData }) })
    });
    const rows = createRowsModel('MembershipFreshnessCompleteDetach');
    const query = rows.query<Response, { group: string }, { group: string }, Row>('group', {
      document,
      key: 'membership-freshness-complete-detach',
      vars: value => value,
      select: data => data.rows,
      into: rows.scopes.group,
      staleTime: Infinity
    });
    const Reader = () => {
      query.use({ group: 'g' });
      return null;
    };
    const Root = ({ mounted }: { mounted: boolean }) => React.createElement(DbProvider, null, mounted ? React.createElement(Reader) : null);
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(Root, { mounted: true }));
    });
    await settle();
    expect(rows.scopes.group.read({ group: 'g' }).map(row => row.id)).toEqual(['detach-1']);

    // Complete coverage over the same scope detaches the membership the query landed, while the row
    // itself stays alive in the row plane.
    act(() => rows.scopes.group.seed({ group: 'g' }, []));

    expect(rows.find('detach-1')).toBeTruthy();
    expect(rows.scopes.group.read({ group: 'g' })).toEqual([]);

    act(() => root.update(React.createElement(Root, { mounted: false })));
    act(() => root.update(React.createElement(Root, { mounted: true })));
    await settle();

    expect(rows.scopes.group.read({ group: 'g' }).map(row => row.id)).toEqual(['detach-2']);
    act(() => root.unmount());
  });

  it('[F16] prunes only the emptied scope and leaves a sibling scope of the same model untouched', async () => {
    const calls: string[] = [];
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        query: async <TData, TVariables,>(operation: { variables?: TVariables }) => {
          const group = String((operation.variables as { group?: string } | undefined)?.group);
          calls.push(group);
          return { data: { rows: [{ id: `${group}-${calls.filter(entry => entry === group).length}`, name: 'Scoped', group }] } as TData };
        }
      })
    });
    const rows = createRowsModel('MembershipFreshnessSiblingScopes');
    const query = rows.query<Response, { group: string }, { group: string }, Row>('group', {
      document,
      key: 'membership-freshness-sibling',
      vars: value => value,
      select: data => data.rows,
      into: rows.scopes.group,
      staleTime: Infinity
    });
    const Reader = ({ group }: { group: string }) => {
      query.use({ group });
      return null;
    };
    const Root = ({ mounted }: { mounted: boolean }) =>
      React.createElement(
        DbProvider,
        null,
        React.createElement(Reader, { group: 'kept' }),
        mounted ? React.createElement(Reader, { group: 'emptied' }) : null
      );
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(Root, { mounted: true }));
    });
    await settle();
    expect(calls).toEqual(['kept', 'emptied']);

    act(() => rows.scopes.group.seed({ group: 'emptied' }, []));
    await settle();

    // The sibling scope never lost membership, so its chain stays fresh and its rows stay on screen.
    expect(rows.scopes.group.read({ group: 'kept' }).map(row => row.id)).toEqual(['kept-1']);
    expect(calls.filter(group => group === 'kept')).toHaveLength(1);

    act(() => root.update(React.createElement(Root, { mounted: false })));
    act(() => root.update(React.createElement(Root, { mounted: true })));
    await settle();

    expect(calls.filter(group => group === 'kept')).toHaveLength(1);
    expect(calls.filter(group => group === 'emptied')).toHaveLength(2);
    act(() => root.unmount());
  });

  it('roots the rows of a mounted reader against a garbage collection sweep', async () => {
    let calls = 0;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        query: async <TData,>() => {
          calls += 1;
          return { data: { rows: [{ id: `gc-${calls}`, name: 'Collected', group: null }] } as TData };
        }
      })
    });
    const rows = createRowsModel('MembershipFreshnessMaintenance');
    const query = rows.query<Response, void, void, Row>('detail', {
      document,
      key: 'membership-freshness-maintenance',
      select: data => data.rows,
      staleTime: Infinity
    });
    const Reader = () => {
      query.use(undefined);
      return null;
    };
    const Root = ({ mounted }: { mounted: boolean }) => React.createElement(DbProvider, null, mounted ? React.createElement(Reader) : null);
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(Root, { mounted: true }));
    });
    await settle();
    expect(calls).toBe(1);

    // Nothing reclaims rows, so the screen keeps its data, the chain stays materialized and no
    // network call fires.
    await settle();
    expect(rows.find('gc-1')).toMatchObject({ name: 'Collected' });
    expect(calls).toBe(1);
    act(() => root.unmount());
  });

});
