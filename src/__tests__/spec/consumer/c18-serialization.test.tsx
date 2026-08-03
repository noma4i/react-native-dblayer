import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { configureDb, defineModel, defineShape, f } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

type FetchInput = { at?: Date; value?: bigint | null | number };
type FetchData = { version: number };
type ResultRow = { id: string; version: number };

const document: TypedDocumentNode<FetchData, FetchInput> = { kind: Kind.DOCUMENT, definitions: [] };
const ResultSchema = defineShape<ResultRow>()({ version: f.num() });

const createFixture = (key: string) => {
  const transport = createMockTransport({
    query: async <TData,>() => ({ data: { version: 1 } as TData })
  });
  configureDb({ storage: createMemoryPlane(), transport });
  const Model = defineModel(key, {
    schema: ResultSchema,
    relations: owner => ({
      result: {
        remote: owner.gql.single(document, {
          variables: (params: FetchInput) => params,
          select: data => ({ id: 'result', version: data.version }),
          staleTime: Number.MAX_SAFE_INTEGER
        })
      }
    })
  });
  return { relation: (params: FetchInput) => Model.result(params), transport };
};

describe('scope-key serialization', () => {
  it('uses distinct fetch cache entries for distinct Date filters', async () => {
    const { relation, transport } = createFixture('C18SerializationDate');

    await relation({ at: new Date('2026-01-01T00:00:00.000Z') }).fetch();
    await relation({ at: new Date('2026-01-02T00:00:00.000Z') }).fetch();

    expect(transport.calls.filter(call => call.kind === 'query')).toHaveLength(2);
  });

  it('uses distinct fetch cache entries for NaN and null filters', async () => {
    const { relation, transport } = createFixture('C18SerializationSpecialValues');

    await relation({ value: Number.NaN }).fetch();
    await relation({ value: null }).fetch();

    expect(transport.calls.filter(call => call.kind === 'query')).toHaveLength(2);
  });

  it('derives a fetch cache key for a bigint filter without throwing', async () => {
    const { relation, transport } = createFixture('C18SerializationBigint');
    const result = relation({ value: 1n });

    await expect(result.fetch()).resolves.toBeUndefined();

    expect(transport.calls.filter(call => call.kind === 'query')).toHaveLength(1);
    expect(result.read()?.version).toBe(1);
  });
});
