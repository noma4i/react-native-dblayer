import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { act } from 'react';
import { Kind } from 'graphql';
import { compositeKey, configureDb, defineModel, defineShape, f, resetRuntime, type DbTransport } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

type Row = { id: string; value: string };
type Scope = { bucket: string };
type Response = { root: Row };
type Variables = Scope;
type ListResponse = { rows: Row[] };
type ConnectionResponse = { rows: { nodes: Row[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };

const document: TypedDocumentNode<Response, Variables> = { kind: Kind.DOCUMENT, definitions: [] };
const listDocument: TypedDocumentNode<ListResponse, Scope> = { kind: Kind.DOCUMENT, definitions: [] };
const connectionDocument: TypedDocumentNode<ConnectionResponse, Scope> = { kind: Kind.DOCUMENT, definitions: [] };
const RowSchema = defineShape<Row>()({ value: f.str() });

describe('query write plan', () => {
  it('commits root and sibling rows in one response envelope', async () => {
    const transport = createMockTransport({
      query: async <TData,>() =>
        ({
          data: { root: { id: 'root-1', value: 'root' } }
        }) as { data: TData }
    });
    configureDb({ storage: createMemoryPlane(), transport });

    const Sibling = defineModel('SpecQueryWritePlanAtomicSibling', { schema: RowSchema });
    const Root = defineModel('SpecQueryWritePlanAtomicRoot', {
      schema: RowSchema,
      relations: owner => ({
        root: {
          remote: owner.gql.single(document, {
            variables: (params: Scope) => params,
            select: data => data.root,
            write: (_context, plan) => {
              plan.upsert(Sibling, { id: 'sibling-1', value: 'sibling' });
            }
          })
        }
      })
    });
    const relation = Root.root({ bucket: 'all' });
    const beforeCommits = diagnostics().snapshot().commits;

    await relation.fetch();

    expect(relation.read()).toEqual({ id: 'root-1', value: 'root' });
    expect(Sibling.find('sibling-1')).toEqual({ id: 'sibling-1', value: 'sibling' });
    expect(diagnostics().snapshot().commits - beforeCommits).toBe(1);
  });

  it('leaves root and sibling response state unchanged when planning throws', async () => {
    const transport = createMockTransport({
      query: async <TData,>() =>
        ({
          data: { root: { id: 'root-2', value: 'root' } }
        }) as { data: TData }
    });
    configureDb({ storage: createMemoryPlane(), transport });

    const Sibling = defineModel('SpecQueryWritePlanFailureSibling', { schema: RowSchema });
    const Root = defineModel('SpecQueryWritePlanFailureRoot', {
      schema: RowSchema,
      relations: owner => ({
        root: {
          remote: owner.gql.single(document, {
            variables: (params: Scope) => params,
            select: data => data.root,
            write: (_context, plan) => {
              plan.upsert(Sibling, { id: 'sibling-2', value: 'sibling' });
              throw new Error('query plan failed');
            }
          })
        }
      })
    });
    const relation = Root.root({ bucket: 'all' });
    const beforeCommits = diagnostics().snapshot().commits;

    await act(async () => {
      await expect(relation.fetch()).rejects.toThrow('query plan failed');
    });

    expect(relation.read()).toBeUndefined();
    expect(Sibling.find('sibling-2')).toBeUndefined();
    expect(diagnostics().snapshot().commits - beforeCommits).toBe(0);
  });

  it('deduplicates one stable invalidation target after both rows land', async () => {
    const transport = createMockTransport({
      query: async <TData,>() =>
        ({
          data: { root: { id: 'root-3', value: 'root' } }
        }) as { data: TData }
    });
    configureDb({ storage: createMemoryPlane(), transport });

    const Sibling = defineModel('SpecQueryWritePlanInvalidationSibling', { schema: RowSchema });
    const snapshots: Array<{ root: Row | undefined; sibling: Row | undefined }> = [];
    const Root = defineModel('SpecQueryWritePlanInvalidationRoot', {
      schema: RowSchema,
      relations: owner => ({
        root: {
          remote: owner.gql.single(document, {
            variables: (params: Scope) => params,
            select: data => data.root,
            write: (_context, plan) => {
              plan.upsert(Sibling, { id: 'sibling-3', value: 'sibling' });
              plan.invalidate(target);
              plan.invalidate(target);
            }
          })
        }
      })
    });
    const relation = Root.root({ bucket: 'all' });
    const target = {
      invalidate: () => {
        snapshots.push({ root: Root.find('root-3'), sibling: Sibling.find('sibling-3') });
      }
    };

    await relation.fetch();

    expect(snapshots).toEqual([{ root: { id: 'root-3', value: 'root' }, sibling: { id: 'sibling-3', value: 'sibling' } }]);
  });

  it('passes list and connection response context into the shared write plan', async () => {
    const transport = createMockTransport({
      query: async <TData,>(operation: Parameters<DbTransport['query']>[0]) =>
        ({
          data:
            operation.query === listDocument
              ? { rows: [{ id: 'list-1', value: 'list' }] }
              : {
                  rows: {
                    nodes: [{ id: 'connection-1', value: 'connection' }],
                    pageInfo: { hasNextPage: false, endCursor: null }
                  }
                }
        }) as { data: TData }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const Sibling = defineModel('SpecQueryWritePlanShapeSibling', { schema: RowSchema });
    const seen: Array<{ kind: string; ids: string[]; bucket: string }> = [];
    const List = defineModel('SpecQueryWritePlanList', {
      schema: RowSchema,
      relations: owner => ({
        rows: {
          remote: owner.gql.list(listDocument, {
            variables: (params: Scope) => params,
            select: data => data.rows,
            write: ({ data, nodes, params }, plan) => {
              seen.push({ kind: 'list', ids: nodes.map(node => node.id), bucket: params.bucket });
              plan.upsert(Sibling, { id: 'list-sibling', value: data.rows[0]!.value });
            }
          })
        }
      })
    });
    const Connection = defineModel('SpecQueryWritePlanConnection', {
      schema: RowSchema,
      relations: owner => ({
        rows: {
          remote: owner.gql.connection(connectionDocument, {
            variables: (params: Scope) => params,
            connection: data => data.rows,
            write: ({ data, nodes, params }, plan) => {
              seen.push({ kind: 'connection', ids: nodes.map(node => node.id), bucket: params.bucket });
              plan.upsert(Sibling, { id: 'connection-sibling', value: data.rows.nodes[0]!.value });
            }
          })
        }
      })
    });

    await List.rows({ bucket: 'list-bucket' }).fetch();
    await Connection.rows({ bucket: 'connection-bucket' }).fetch();

    expect(seen).toEqual([
      { kind: 'list', ids: ['list-1'], bucket: 'list-bucket' },
      { kind: 'connection', ids: ['connection-1'], bucket: 'connection-bucket' }
    ]);
    expect(Sibling.find('list-sibling')).toEqual({ id: 'list-sibling', value: 'list' });
    expect(Sibling.find('connection-sibling')).toEqual({ id: 'connection-sibling', value: 'connection' });
  });

  it('fences write compilation and invalidation callbacks at the runtime generation', async () => {
    const responseTransport = () => createMockTransport({
      query: async <TData,>() => ({ data: { root: { id: 'root', value: 'root' } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport: responseTransport() });
    const ResetScalar = f.custom<string, string>(value => {
      resetRuntime();
      return value;
    });
    const Sibling = defineModel('SpecQueryWriteFenceSibling', {
      schema: defineShape<Row>()({ value: ResetScalar })
    });
    const WriteReset = defineModel('SpecQueryWriteFenceRoot', {
      schema: RowSchema,
      relations: owner => ({
        root: {
          remote: owner.gql.single(document, {
            variables: (params: Scope) => params,
            select: data => data.root,
            write: (_context, plan) => plan.upsert(Sibling, { id: 'sibling', value: 'reset' })
          })
        }
      })
    });
    await expect(WriteReset.root({ bucket: 'write' }).fetch()).rejects.toThrow('runtime was reset before it resolved');

    const onSyncError = jest.fn();
    configureDb({ storage: createMemoryPlane(), transport: responseTransport(), defaults: { onSyncError } });
    const InvalidationFailure = defineModel('SpecQueryInvalidationFailure', {
      schema: RowSchema,
      relations: owner => ({
        root: {
          remote: owner.gql.single(document, {
            variables: (params: Scope) => params,
            select: data => data.root,
            write: (_context, plan) => plan.invalidate({ invalidate: () => { throw new Error('invalidate failed'); } })
          })
        }
      })
    });
    await expect(InvalidationFailure.root({ bucket: 'failure' }).fetch()).resolves.toBeUndefined();
    expect(onSyncError).toHaveBeenCalledWith(expect.any(Error), {
      source: 'query',
      model: InvalidationFailure.key,
      key: compositeKey(InvalidationFailure.key, 'root')
    });

    configureDb({ storage: createMemoryPlane(), transport: responseTransport() });
    const InvalidationReset = defineModel('SpecQueryInvalidationReset', {
      schema: RowSchema,
      relations: owner => ({
        root: {
          remote: owner.gql.single(document, {
            variables: (params: Scope) => params,
            select: data => data.root,
            write: (_context, plan) => plan.invalidate({ invalidate: () => resetRuntime() })
          })
        }
      })
    });
    await expect(InvalidationReset.root({ bucket: 'reset' }).fetch()).rejects.toThrow('runtime was reset before it resolved');
  });
});
