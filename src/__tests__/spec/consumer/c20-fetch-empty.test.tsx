import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { configureDb, defineModel, defineShape, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, recordTimelineInProvider, settle } from '../helpers/harness';

type NullableResponse = { value: null };
type ValueResponse = { value: string };
type NullableRow = { id: string; value: null };
type ValueRow = { id: string; value: string };
type BucketRow = { id: string; bucket: string };
type ListResponse = { rows: BucketRow[] | null };
type ConnectionResponse = { rows: { nodes: BucketRow[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } | null };

const nullableDocument: TypedDocumentNode<NullableResponse, Record<string, never>> = { kind: Kind.DOCUMENT, definitions: [] };
const valueDocument: TypedDocumentNode<ValueResponse, Record<string, never>> = { kind: Kind.DOCUMENT, definitions: [] };
const listDocument: TypedDocumentNode<ListResponse, { bucket: string }> = { kind: Kind.DOCUMENT, definitions: [] };
const connectionDocument: TypedDocumentNode<ConnectionResponse, { bucket: string }> = { kind: Kind.DOCUMENT, definitions: [] };
const NullableSchema = defineShape<NullableRow>()({ value: f.str().nullable() });
const ValueSchema = defineShape<ValueRow>()({ value: f.str() });
const BucketSchema = defineShape<BucketRow>()({ bucket: f.str() });

describe('model relation empty loading state', () => {
  it('shows an empty state for a null selected result', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ query: async <TData,>() => ({ data: { value: null } as TData }) })
    });
    const NullableModel = defineModel('C20FetchEmptyNullable', {
      schema: NullableSchema,
      relations: owner => ({
        result: {
          remote: owner.gql.single(nullableDocument, {
            variables: () => ({}),
            select: data => data.value
          })
        }
      })
    });
    const relation = NullableModel.result({});
    let latest!: ReturnType<typeof relation.use>;
    const reader = recordTimelineInProvider(() => {
      const result = relation.use();
      latest = result;
      return result;
    });

    await settle(6, { macro: true });

    expect({ hasData: latest.loadingState.hasData, showEmptyState: latest.loadingState.showEmptyState }).toEqual({ hasData: false, showEmptyState: true });
    reader.unmount();
  });

  it('keeps data state for a non-empty selected result', async () => {
    const transport = createMockTransport({ query: async <TData,>() => ({ data: { value: 'ready' } as TData }) });
    configureDb({ storage: createMemoryPlane(), transport });
    const ValueModel = defineModel('C20FetchEmptyValue', {
      schema: ValueSchema,
      relations: owner => ({
        result: {
          remote: owner.gql.single(valueDocument, {
            variables: () => ({}),
            select: data => ({ id: 'result', value: data.value })
          })
        }
      })
    });
    const relation = ValueModel.result({});
    let latest!: ReturnType<typeof relation.use>;
    const reader = recordTimelineInProvider(() => {
      const result = relation.use();
      latest = result;
      return result;
    });

    await settle(6, { macro: true });

    expect({ hasData: latest.loadingState.hasData, showEmptyState: latest.loadingState.showEmptyState }).toEqual({ hasData: true, showEmptyState: false });
    reader.unmount();
  });
});

/**
 * A nullish list/connection payload is not an empty list: it is a refused landing. The existing
 * members and the accumulated chain survive and the failure is reported.
 */
describe('nullish relation payload refusal', () => {
  it('[F47] refuses a null list payload and keeps the landed members', async () => {
    const onSyncError = jest.fn();
    let served = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        served += 1;
        return { data: (served === 1 ? { rows: [{ id: 'row-1', bucket: 'a' }] } : { rows: null }) as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport, defaults: { onSyncError } });
    const Model = defineModel('C20NullListRefusal', {
      schema: BucketSchema,
      relations: owner => ({
        byBucket: {
          by: { bucket: 'bucket' },
          remote: owner.gql.list(listDocument, {
            variables: (scope: { bucket: string }) => scope,
            select: data => data.rows
          })
        }
      })
    });
    const relation = Model.byBucket({ bucket: 'a' });
    await relation.fetch();
    expect(relation.read().map(row => row.id)).toEqual(['row-1']);

    await expect(relation.refresh()).rejects.toThrow('nullish list payload');

    expect(onSyncError).toHaveBeenCalledTimes(1);
    expect(relation.read().map(row => row.id)).toEqual(['row-1']);
  });

  it('[F47] refuses a null connection payload and keeps the landed members', async () => {
    const onSyncError = jest.fn();
    let served = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        served += 1;
        return {
          data: (served === 1
            ? { rows: { nodes: [{ id: 'row-1', bucket: 'a' }], pageInfo: { hasNextPage: false, endCursor: null } } }
            : { rows: null }) as TData
        };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport, defaults: { onSyncError } });
    const Model = defineModel('C20NullConnectionRefusal', {
      schema: BucketSchema,
      relations: owner => ({
        byBucket: {
          by: { bucket: 'bucket' },
          sort: 'server-order',
          remote: owner.gql.connection(connectionDocument, {
            variables: (scope: { bucket: string }) => scope,
            connection: data => data.rows
          })
        }
      })
    });
    const relation = Model.byBucket({ bucket: 'a' });
    await relation.fetch();
    expect(relation.read().map(row => row.id)).toEqual(['row-1']);

    await expect(relation.refresh()).rejects.toThrow('nullish connection payload');

    expect(onSyncError).toHaveBeenCalledTimes(1);
    expect(relation.read().map(row => row.id)).toEqual(['row-1']);
  });
});
