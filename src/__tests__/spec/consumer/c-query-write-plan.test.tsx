import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { act } from 'react';
import { Kind } from 'graphql';
import { configureDb, defineModel, defineShape, f, gql } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

type Row = { id: string; value: string };
type Scope = { bucket: string };
type Response = { root: Row };
type Variables = Scope;

const document: TypedDocumentNode<Response, Variables> = { kind: Kind.DOCUMENT, definitions: [] };
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
      relations: {
        root: {
          remote: gql.single(document, {
            variables: (params: Scope) => params,
            select: data => data.root,
            write: (_context, plan) => {
              plan.upsert(Sibling, { id: 'sibling-1', value: 'sibling' });
            }
          })
        }
      }
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
      relations: {
        root: {
          remote: gql.single(document, {
            variables: (params: Scope) => params,
            select: data => data.root,
            write: (_context, plan) => {
              plan.upsert(Sibling, { id: 'sibling-2', value: 'sibling' });
              throw new Error('query plan failed');
            }
          })
        }
      }
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
      relations: {
        root: {
          remote: gql.single(document, {
            variables: (params: Scope) => params,
            select: data => data.root,
            write: (_context, plan) => {
              plan.upsert(Sibling, { id: 'sibling-3', value: 'sibling' });
              plan.invalidate(target);
              plan.invalidate(target);
            }
          })
        }
      }
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
});
