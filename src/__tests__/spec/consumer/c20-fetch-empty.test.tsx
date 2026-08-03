import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { configureDb, defineModel, defineShape, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, recordTimelineInProvider, settle } from '../helpers/harness';

type NullableResponse = { value: null };
type ValueResponse = { value: string };
type NullableRow = { id: string; value: null };
type ValueRow = { id: string; value: string };

const nullableDocument: TypedDocumentNode<NullableResponse, Record<string, never>> = { kind: Kind.DOCUMENT, definitions: [] };
const valueDocument: TypedDocumentNode<ValueResponse, Record<string, never>> = { kind: Kind.DOCUMENT, definitions: [] };
const NullableSchema = defineShape<NullableRow>()({ value: f.str().nullable() });
const ValueSchema = defineShape<ValueRow>()({ value: f.str() });

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
