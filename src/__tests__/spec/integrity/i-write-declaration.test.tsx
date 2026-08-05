import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind, OperationTypeNode } from 'graphql';
import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import {
  configureDb,
  defineModel,
  defineShape,
  f,
  resetRuntime,
  useDbSubscriptions,
  type DbTransport
} from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

type Media = {
  width: number | null;
  height: number | null;
  fileUrl: string | null;
  blurHash: string | null;
};
type Row = { id: string; body: string; media: Media };
type QueryData = { rows: Row[] };
type QueryVariables = Record<string, never>;
type ActionData = { send: { message: Row } };
type ActionVariables = { input: { body: string } };
type EventData = { received: { message: Row } };

const MediaSchema = defineShape<Media>()({
  width: f.num().nullable(),
  height: f.num().nullable(),
  fileUrl: f.str().nullable(),
  blurHash: f.str().nullable()
});
const RowSchema = defineShape<Row>()({ body: f.str(), media: f.object(MediaSchema) });
const queryDocument: TypedDocumentNode<QueryData, QueryVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const actionDocument: TypedDocumentNode<ActionData, ActionVariables> = { kind: Kind.DOCUMENT, definitions: [] };
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
        selections: [{ kind: Kind.FIELD, name: { kind: Kind.NAME, value: 'received' }, arguments: [], directives: [] }]
      }
    }
  ]
};
const write = {
  groups: [
    {
      fields: ['media'] as const,
      policy: {
        keys: {
          width: 'positive' as const,
          height: 'positive' as const,
          fileUrl: 'nonEmpty' as const,
          blurHash: 'nonEmpty' as const
        }
      }
    }
  ]
};
const localMedia: Media = { width: 320, height: 240, fileUrl: 'file:///local.mp4', blurHash: null };
const serverMedia: Media = { width: 0, height: 0, fileUrl: 'https://cdn/file.mp4', blurHash: 'server-blur' };
const expectedMedia: Media = { width: 320, height: 240, fileUrl: 'https://cdn/file.mp4', blurHash: 'server-blur' };

function Activation(): null {
  useDbSubscriptions(true);
  return null;
}

afterEach(resetRuntime);

describe('model-owned write declarations', () => {
  it('does not apply a query response with GraphQL errors', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({
        data: { rows: [{ id: 'row-1', body: 'rejected', media: serverMedia }] } as TData,
        errors: [{ message: 'forbidden' }]
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = defineModel('WriteDeclarationGraphqlErrors', {
      schema: RowSchema,
      write,
      relations: owner => ({
        remote: {
          remote: owner.gql.list(queryDocument, {
            variables: (params: QueryVariables) => params,
            select: data => data.rows
          })
        }
      })
    });

    await expect(rows.remote({}).fetch()).rejects.toThrow('forbidden');

    expect(rows.find('row-1')).toBeUndefined();
  });

  it('[W5] uses the same field policy for query and model event landings', async () => {
    let next!: (data: unknown) => void;
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { rows: [{ id: 'query-1', body: 'query-server', media: serverMedia }] } as TData }),
      subscribe: (
        _options: Parameters<NonNullable<DbTransport['subscribe']>>[0],
        handlers: Parameters<NonNullable<DbTransport['subscribe']>>[1]
      ) => {
        next = handlers.next;
        return () => undefined;
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = defineModel('WriteDeclarationRemoteChannels', {
      schema: RowSchema,
      write,
      relations: owner => ({
        remote: {
          remote: owner.gql.list(queryDocument, {
            variables: (params: QueryVariables) => params,
            select: data => data.rows
          })
        }
      }),
      events: owner => ({
        received: owner.gql.live(eventDocument, {
          variables: {},
          root: { insert: { select: ({ payload }) => payload.message } }
        })
      })
    });
    rows.insertMany([
      { id: 'query-1', body: 'query-local', media: localMedia },
      { id: 'event-1', body: 'event-local', media: localMedia }
    ]);
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(Activation));
    });

    await rows.remote({}).fetch();
    act(() => next({ received: { message: { id: 'event-1', body: 'event-server', media: serverMedia } } }));

    expect(rows.find('query-1')).toEqual({ id: 'query-1', body: 'query-server', media: expectedMedia });
    expect(rows.find('event-1')).toEqual({ id: 'event-1', body: 'event-server', media: expectedMedia });
    act(() => root.unmount());
  });

  it('uses the same field policy during an action temp-to-server replace', async () => {
    const transport = createMockTransport({
      mutation: async <TData,>() => ({
        data: { send: { message: { id: 'server-1', body: 'server-body', media: serverMedia } } } as TData
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = defineModel('WriteDeclarationActionReplace', {
      schema: RowSchema,
      write,
      maintenance: { dropTempRowsAfterMs: 1000 },
      actions: owner => ({
        send: owner.gql.action(actionDocument, {
          mode: 'request',
          result: 'send',
          variables: (input: ActionVariables['input']) => ({ input }),
          optimistic: {
            root: {
              insert: {
                select: ({ input, tempId }) => ({ id: tempId, body: input.body, media: localMedia })
              }
            }
          },
          root: { insert: { select: ({ data }) => data.send.message } }
        })
      })
    });

    await act(async () => {
      await rows.actions.send.run({ body: 'optimistic-body' });
    });

    expect(rows.find('server-1')).toEqual({ id: 'server-1', body: 'server-body', media: expectedMedia });
  });

  it('[W4] treats every field as server-authoritative when a model declares no write groups', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { rows: [{ id: 'row-1', body: 'server-body', media: serverMedia }] } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = defineModel('WriteDeclarationServerAuthoritative', {
      schema: RowSchema,
      relations: owner => ({
        remote: {
          remote: owner.gql.list(queryDocument, {
            variables: (params: QueryVariables) => params,
            select: data => data.rows
          })
        }
      })
    });
    rows.insert({ id: 'row-1', body: 'local-body', media: localMedia });

    await rows.remote({}).fetch();

    // Without write groups the zero dimensions land verbatim, where a grouped model keeps the local ones.
    expect(rows.find('row-1')).toEqual({ id: 'row-1', body: 'server-body', media: serverMedia });
  });
});
