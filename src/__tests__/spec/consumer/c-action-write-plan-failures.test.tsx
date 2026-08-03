import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { act } from 'react';
import { configureDb, defineModel, defineShape, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics, renderCounted } from '../helpers/harness';

type Row = { id: string; value: string };
type RootInput = { value: string };
type RootResponse = { rootAction: { root: Row } };
type RootVariables = { input: RootInput };

const rootDocument: TypedDocumentNode<RootResponse, RootVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const RowSchema = defineShape<Row>()({
  value: f.str()
});

describe('action write plan failure boundaries', () => {
  it('publishes a rejected action through the shared hook state', async () => {
    const failure = new Error('transport failed');
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ mutation: async () => Promise.reject(failure) })
    });
    const Root = defineModel('SpecActionHookFailure', {
      schema: RowSchema,
      actions: owner => ({
        apply: owner.gql.action(rootDocument, {
          mode: 'request',
          result: 'rootAction',
          variables: (input: RootInput) => ({ input }),
          root: { insert: { select: ({ data }) => data.rootAction.root } }
        })
      })
    });
    const handle = renderCounted(() => Root.actions.apply.use());

    await act(async () => {
      await expect(handle.result().run({ value: 'input' })).rejects.toBe(failure);
    });

    expect(handle.result()).toMatchObject({ isPending: false, error: failure });
    handle.unmount();
  });

  it('retains the failed optimistic root when planning fails after a sibling intent', async () => {
    const transport = createMockTransport({
      mutation: async <TData,>() =>
        ({
          data: {
            rootAction: {
              root: { id: 'server-root', value: 'server' }
            }
          }
        }) as { data: TData }
    });
    configureDb({ storage: createMemoryPlane(), transport });

    const Sibling = defineModel('SpecActionWritePlanFailureSibling', { schema: RowSchema });
    let optimisticId = '';
    const Root = defineModel('SpecActionWritePlanFailureRoot', {
      schema: RowSchema,
      maintenance: { dropTempRowsAfterMs: 60_000 },
      actions: owner => ({
        apply: owner.gql.action(rootDocument, {
          mode: 'request',
          result: 'rootAction',
          variables: (input: RootInput) => ({ input }),
          root: { insert: { select: ({ data }) => data.rootAction.root } },
          optimistic: {
            root: {
              insert: {
                select: ({ tempId }) => {
                  optimisticId = tempId;
                  return { id: tempId, value: 'optimistic' };
                }
              }
            }
          },
          write: (_context, plan) => {
            plan.upsert(Sibling, { id: 'sibling-1', value: 'planned' });
            throw new Error('plan failed');
          }
        })
      })
    });

    const beforeCommits = diagnostics().snapshot().commits;
    await act(async () => {
      await expect(Root.actions.apply.run({ value: 'input' })).rejects.toThrow('plan failed');
    });

    expect(Root.find(optimisticId)).toEqual({ id: optimisticId, value: 'optimistic' });
    expect(Root.find('server-root')).toBeUndefined();
    expect(Sibling.find('sibling-1')).toBeUndefined();
    expect(Root.operation(optimisticId).read()).toEqual({ pending: false, failed: true, unsyncedChanges: undefined });
    expect(diagnostics().snapshot().commits - beforeCommits).toBe(2);
  });

  it('deduplicates one stable invalidation target and runs it after committed rows land', async () => {
    const transport = createMockTransport({
      mutation: async <TData,>() =>
        ({
          data: {
            rootAction: {
              root: { id: 'root-1', value: 'root' }
            }
          }
        }) as { data: TData }
    });
    configureDb({ storage: createMemoryPlane(), transport });

    const Sibling = defineModel('SpecActionWritePlanSuccessSibling', { schema: RowSchema });
    const snapshots: Array<{ root: Row | undefined; sibling: Row | undefined }> = [];
    let target = { invalidate: () => undefined };
    const Root = defineModel('SpecActionWritePlanSuccessRoot', {
      schema: RowSchema,
      actions: owner => ({
        apply: owner.gql.action(rootDocument, {
          mode: 'request',
          result: 'rootAction',
          variables: (input: RootInput) => ({ input }),
          root: { insert: { select: ({ data }) => data.rootAction.root } },
          write: (_context, plan) => {
            plan.upsert(Sibling, { id: 'sibling-1', value: 'sibling' });
            plan.invalidate(target);
            plan.invalidate(target);
          }
        })
      })
    });
    target = {
      invalidate: () => {
        snapshots.push({ root: Root.find('root-1'), sibling: Sibling.find('sibling-1') });
      }
    };

    await act(async () => {
      await Root.actions.apply.run({ value: 'input' });
    });

    expect(snapshots).toEqual([{ root: { id: 'root-1', value: 'root' }, sibling: { id: 'sibling-1', value: 'sibling' } }]);
  });
});
