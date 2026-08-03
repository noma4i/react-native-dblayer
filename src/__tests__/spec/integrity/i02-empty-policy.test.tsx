import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { DbProvider, configureDb, defineModel, defineShape, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCountedInProvider, settle } from '../helpers/harness';

type Item = { id: string; bucket: string };
type QueryResponse = { items: { nodes: Item[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
type QueryVariables = { after?: string };
type RelationParams = { bucket: string; after?: string };

const document: TypedDocumentNode<QueryResponse, QueryVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const ItemSchema = defineShape<Item>()({ bucket: f.str() });

const mountTwice = async (Reader: React.ComponentType): Promise<void> => {
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
  });
  await settle(4, { macro: true });
  act(() => root.unmount());
  await act(async () => {
    root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
  });
  await settle(4, { macro: true });
  act(() => root.unmount());
};

const createQueryCase = (suffix: string, rows: Item[], options: { emptyStaleTime?: number; defaultsEmptyStaleTime?: number }) => {
  let calls = 0;
  const transport = createMockTransport({
    query: async <TData,>() => {
      calls += 1;
      return { data: { items: { nodes: rows, pageInfo: { hasNextPage: false, endCursor: null } } } as TData };
    }
  });
  configureDb({
    storage: createMemoryPlane(),
    transport,
    defaults: { staleTime: 60 * 60 * 1000, emptyStaleTime: options.defaultsEmptyStaleTime }
  });
  const items = defineModel(`SpecEmptyQuery${suffix}`, {
    schema: ItemSchema,
    relations: owner => ({
      byBucket: {
        by: { bucket: 'bucket' },
        sort: 'server-order',
        remote: owner.gql.connection(document, {
          variables: (params: RelationParams) => (params.after === undefined ? {} : { after: params.after }),
          connection: data => data.items,
          staleTime: 60 * 60 * 1000,
          emptyStaleTime: options.emptyStaleTime
        })
      }
    })
  });
  const relation = items.byBucket({ bucket: 'A' });
  const Reader = () => {
    relation.use();
    return null;
  };
  return { Reader, calls: () => calls };
};

describe('empty result freshness policy', () => {
  it('refetches an empty scope-destination query immediately on the next mount', async () => {
    const testCase = createQueryCase('Empty', [], { emptyStaleTime: 0 });

    await mountTwice(testCase.Reader);

    expect(testCase.calls()).toBe(2);
  });

  it('keeps a non-empty scope-destination query fresh for its normal stale time', async () => {
    const testCase = createQueryCase('NonEmpty', [{ id: 'item-1', bucket: 'A' }], { emptyStaleTime: 0 });

    await mountTwice(testCase.Reader);

    expect(testCase.calls()).toBe(1);
  });

  it('keeps an accumulated connection fresh when only its final page is empty', async () => {
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        return {
          data: {
            items:
              calls === 1
                ? { nodes: [{ id: 'item-1', bucket: 'A' }], pageInfo: { hasNextPage: true, endCursor: 'next' } }
                : { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
          }
        } as TData;
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const items = defineModel('SpecEmptyQueryAccumulatedConnection', {
      schema: ItemSchema,
      relations: owner => ({
        byBucket: {
          by: { bucket: 'bucket' },
          sort: 'server-order',
          remote: owner.gql.connection(document, {
            variables: (params: RelationParams) => (params.after === undefined ? {} : { after: params.after }),
            connection: data => data.items,
            coverage: 'page',
            staleTime: 60 * 60 * 1000,
            emptyStaleTime: 0
          })
        }
      })
    });
    const relation = items.byBucket({ bucket: 'A' });
    const first = renderCountedInProvider(() => relation.use({ loadMoreDebounceMs: 0 }));
    await settle();
    await settle(1, { macro: true });
    act(() => {
      first.result().loadMore();
    });
    await settle();
    await settle(1, { macro: true });
    first.unmount();

    const second = renderCountedInProvider(() => relation.use());
    await settle();
    await settle(1, { macro: true });
    second.unmount();

    expect(calls).toBe(2);
  });

  it('flows the configured empty stale default into model queries', async () => {
    const testCase = createQueryCase('Default', [], { defaultsEmptyStaleTime: 0 });

    await mountTwice(testCase.Reader);

    expect(testCase.calls()).toBe(2);
  });

});
