import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind, OperationTypeNode } from 'graphql';
import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { configureDb, defineModel, defineModelRuntime, defineShape, f, useDbSubscriptions, type DbTransport } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted, settle, renderCountedInProvider } from '../helpers/harness';

type MomentRow = { id: string; userId: string; status: string };
type ScopeValue = { userId: string };
type QueryResponse = { moment: { id: string | number; userId: number; status: string } };
type PatchResponse = { updateMoment: MomentRow };

const document = { kind: 'Document', definitions: [] } as never;
const MomentSchema = defineShape<MomentRow>()({ userId: f.id(), status: f.str() });

const createMoments = () =>
  defineModelRuntime({
    id: 'SpecConsumerIdKeyMoment',
    name: 'SpecConsumerIdKeyMoment',
    fields: {
      id: f.str(),
      userId: f.id(),
      status: f.str()
    },
    scopes: {
      byUser: ({ by: { userId: 'userId' } })
    }
  });

describe('id-key normalization contracts (LC20)', () => {
  it('uses rowId normalization for scope membership when the transport row has no id field', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => {
        return { data: { rows: [{ sourceId: 77, userId: 54, status: 'active' }] } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = defineModelRuntime({
      id: 'SpecConsumerScopeRowId',
      name: 'SpecConsumerScopeRowId',
      fields: { userId: f.id(), status: f.str() },
      rowId: input => (input as { sourceId: string | number }).sourceId,
      scopes: { byUser: { by: { userId: 'userId' } } }
    });
    const query = rows.query<{ rows: Array<{ sourceId: number; userId: number; status: string }> }, ScopeValue, ScopeValue, { id: string; userId: string; status: string }>(
      'scope-row-id',
      {
        document,
        vars: value => value,
        select: data => data.rows,
        into: rows.scopes.byUser
      }
    );
    const reader = renderCountedInProvider(() => query.use({ userId: '54' }));

    await settle();

    expect(reader.result().data.map(row => row.id)).toEqual(['77']);
    expect(rows.find('77')?.status).toBe('active');
    reader.unmount();
  });

  it('uses rowId normalization for point query result identity when the transport row has no id field', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => {
        return { data: { row: { sourceId: 77, userId: 54, status: 'active' } } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = defineModelRuntime({
      id: 'SpecConsumerPointRowId',
      name: 'SpecConsumerPointRowId',
      fields: { userId: f.id(), status: f.str() },
      rowId: input => (input as { sourceId: string | number }).sourceId
    });
    const query = rows.query<
      { row: { sourceId: number; userId: number; status: string } },
      ScopeValue,
      ScopeValue,
      { id: string; userId: string; status: string }
    >('point-row-id', {
      document,
      vars: value => value,
      select: data => data.row,
      into: rows
    });
    const reader = renderCountedInProvider(() => query.use({ userId: '54' }));

    await settle();

    expect(reader.result().data).toEqual({ id: '77', userId: '54', status: 'active' });
    reader.unmount();
  });

  it('files a numeric-transport userId into the same scope bucket a string read key resolves', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => {
        return { data: { moment: { id: 'moment-1', userId: 54, status: 'active' } } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createMoments();
    const query = moments.query<QueryResponse, ScopeValue, ScopeValue, MomentRow>('single-moment', {
      document,
      vars: value => ({ userId: value.userId }),
      select: data => data.moment,
      into: moments.scopes.byUser
    });

    const scopeReader = renderCounted(() => moments.scopes.byUser.use({ userId: '54' }));
    const queryReader = renderCountedInProvider(() => query.use({ userId: '54' }));

    await settle();

    expect(scopeReader.result().map(row => row.id)).toEqual(['moment-1']);

    scopeReader.unmount();
    queryReader.unmount();
  });

  it('matches a stored id-typed field against a numeric where filter', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const moments = createMoments();
    moments.insert({ id: 'moment-1', userId: '54', status: 'active' });

    const reader = renderCounted(() => moments.use.where({ userId: 54 as unknown as string }).rows());

    expect(reader.result().map(row => row.id)).toEqual(['moment-1']);
    reader.unmount();
  });

  it('resolves a point read when the id argument arrives numeric', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const moments = createMoments();
    moments.insert({ id: '54', userId: '54', status: 'active' });

    const reader = renderCounted(() => moments.use.find(54 as unknown as string));

    expect(reader.result()?.id).toBe('54');
    reader.unmount();
  });

  it('resolves byIds when an id argument arrives numeric', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const moments = createMoments();
    moments.insert({ id: '54', userId: '54', status: 'active' });

    const reader = renderCounted(() => moments.use.byIds([54 as unknown as string]));

    expect(reader.result().rows.map(row => (row as { id: string }).id)).toEqual(['54']);
    reader.unmount();
  });

  it('keys a present byIds row by its actual id when an earlier requested id is missing', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const moments = createMoments();
    moments.insert({ id: 'present', userId: '54', status: 'active' });

    const reader = renderCounted(() => moments.use.byIds(['missing', 'present']));

    expect(reader.result().rows).toHaveLength(1);
    expect(reader.result().byId.get('present')?.id).toBe('present');
    expect(reader.result().byId.get('missing')).toBeUndefined();
    reader.unmount();
  });

  it('keeps byIds map keys independent of a renderKeys projection that excludes id', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const moments = createMoments();
    moments.insert({ id: 'present', userId: '54', status: 'active' });

    const reader = renderCounted(() => moments.use.byIds(['missing', 'present'], { renderKeys: ['status'] }));

    expect(reader.result().rows).toHaveLength(1);
    expect(reader.result().byId.has('present')).toBe(true);
    expect(reader.result().byId.has('missing')).toBe(false);
    reader.unmount();
  });

  it('accepts a numeric primary id from the transport and reads it by string id', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => {
        return { data: { moment: { id: 77, userId: 54, status: 'active' } } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createMoments();
    const query = moments.query<QueryResponse, ScopeValue, ScopeValue, MomentRow>('single-moment', {
      document,
      vars: value => ({ userId: value.userId }),
      select: data => data.moment,
      into: moments.scopes.byUser
    });

    const rowReader = renderCounted(() => moments.use.find('77'));
    const queryReader = renderCountedInProvider(() => query.use({ userId: '54' }));

    await settle();

    expect(rowReader.result()?.id).toBe('77');

    rowReader.unmount();
    queryReader.unmount();
  });

  it('patches a string-keyed row when the write id arrives numeric', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const moments = createMoments();
    moments.insert({ id: '54', userId: '54', status: 'active' });

    moments.update(54 as unknown as string, { status: 'patched' });

    expect(moments.find('54')?.status).toBe('patched');
  });

  it('destroys a string-keyed row when the write id arrives numeric', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const moments = createMoments();
    moments.insert({ id: '54', userId: '54', status: 'active' });

    moments.destroy(54 as unknown as string);

    expect(moments.find('54')).toBeUndefined();
  });

  it('destroys a string-keyed row for a numeric model event id', () => {
    type EventData = { removed: { id: string } };
    const eventDocument: TypedDocumentNode<EventData, Record<string, never>> = {
      kind: Kind.DOCUMENT,
      definitions: [
        {
          kind: Kind.OPERATION_DEFINITION,
          operation: OperationTypeNode.SUBSCRIPTION,
          variableDefinitions: [],
          directives: [],
          selectionSet: {
            kind: Kind.SELECTION_SET,
            selections: [{ kind: Kind.FIELD, name: { kind: Kind.NAME, value: 'removed' }, arguments: [], directives: [] }]
          }
        }
      ]
    };
    let next!: (data: unknown) => void;
    const transport = createMockTransport({
      subscribe: (
        _options: Parameters<NonNullable<DbTransport['subscribe']>>[0],
        handlers: Parameters<NonNullable<DbTransport['subscribe']>>[1]
      ) => {
        next = handlers.next;
        return () => undefined;
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = defineModel('SpecConsumerNumericEventId', {
      schema: MomentSchema,
      events: owner => ({
        removed: owner.gql.live(eventDocument, {
          variables: {},
          root: { destroy: { select: ({ payload }) => payload.id } }
        })
      })
    });
    function Activation(): null {
      useDbSubscriptions(true);
      return null;
    }
    moments.insert({ id: '54', userId: '54', status: 'active' });
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(Activation));
    });

    act(() => next({ removed: { id: 54 } }));

    expect(moments.find('54')).toBeUndefined();
    act(() => root.unmount());
  });

  it('tracks a numeric-id method patch through the normalized string lookup key', async () => {
    let resolveMutation!: (value: { data: PatchResponse }) => void;
    const transport = createMockTransport({
      mutation: async <TData,>() =>
        await new Promise<{ data: TData }>(resolve => {
          resolveMutation = resolve as unknown as (value: { data: PatchResponse }) => void;
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    type PatchVariables = { input: { id: string } };
    const patchDocument: TypedDocumentNode<PatchResponse, PatchVariables> = { kind: Kind.DOCUMENT, definitions: [] };
    const moments = defineModel('SpecConsumerNumericActionId', {
      schema: MomentSchema,
      actions: owner => ({
        update: owner.gql.action(patchDocument, {
          mode: 'request',
          result: 'updateMoment',
          variables: input => ({ input }),
          optimistic: { root: { update: { select: ({ input }) => ({ id: input.id, patch: { status: 'pending' } }) } } },
          root: { update: { select: ({ data }) => ({ id: data.updateMoment.id, patch: { status: data.updateMoment.status } }) } }
        })
      })
    });
    moments.insert({ id: '54', userId: '54', status: 'active' });
    const reader = renderCounted(() => moments.operation('54').use().pending);
    let request!: Promise<PatchResponse['updateMoment'] | null>;

    act(() => {
      request = moments.actions.update.run({ id: 54 as unknown as string });
    });
    const pendingWhileInFlight = reader.result();
    resolveMutation({ data: { updateMoment: { id: '54', userId: '54', status: 'pending' } } });
    await act(async () => {
      await request;
    });

    expect(pendingWhileInFlight).toBe(true);
    expect(reader.result()).toBe(false);
    reader.unmount();
  });

  it('matches a numeric where filter against the primary id key when id is not a declared field', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const widgets = defineModelRuntime({
      id: 'SpecConsumerIdKeyWidget',
      name: 'SpecConsumerIdKeyWidget',
      fields: { label: f.str() }
    });
    widgets.insert({ id: '54', label: 'w' } as never);

    const reader = renderCounted(() => widgets.use.where({ id: 54 as unknown as string }).rows());

    expect(reader.result().map(row => (row as { id: string }).id)).toEqual(['54']);
    reader.unmount();
  });

  it('reads a scope bucket when the scope value arrives numeric (read-write key symmetry)', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const moments = createMoments();
    moments.insert({ id: 'moment-1', userId: '54', status: 'active' });

    const reader = renderCounted(() => moments.scopes.byUser.use({ userId: 54 as unknown as string }));

    expect(reader.result().map(row => row.id)).toEqual(['moment-1']);
    reader.unmount();
  });
});
