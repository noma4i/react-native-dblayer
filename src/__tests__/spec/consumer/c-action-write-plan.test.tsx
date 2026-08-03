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

describe('action write plan', () => {
  it('commits the root and declared cross-model writes in one response envelope', async () => {
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

    const Added = defineModel('SpecActionWritePlanAdded', { schema: RowSchema });
    const Changed = defineModel('SpecActionWritePlanChanged', { schema: RowSchema });
    const Removed = defineModel('SpecActionWritePlanRemoved', { schema: RowSchema });
    const Unrelated = defineModel('SpecActionWritePlanUnrelated', { schema: RowSchema });
    const Root = defineModel('SpecActionWritePlanRoot', {
      schema: RowSchema,
      actions: owner => ({
        apply: owner.gql.action(
          rootDocument,
          {
            mode: 'request',
            result: 'rootAction',
            variables: (input: RootInput) => ({ input }),
            root: { insert: { select: ({ data }) => data.rootAction.root } },
            write: (_context, plan) => {
              plan.upsert(Added, { id: 'added-1', value: 'added' });
              plan.update(Changed, 'changed-1', { value: 'changed' });
              plan.destroy(Removed, 'removed-1');
            }
          }
        )
      })
    });

    Changed.insert({ id: 'changed-1', value: 'before' });
    Removed.insert({ id: 'removed-1', value: 'before' });
    Unrelated.insert({ id: 'unrelated-1', value: 'untouched' });
    diagnostics().reset();

    const rootReader = renderCounted(() => Root.useFind('root-1'));
    const addedReader = renderCounted(() => Added.useFind('added-1'));
    const changedReader = renderCounted(() => Changed.useFind('changed-1'));
    const removedReader = renderCounted(() => Removed.useFind('removed-1'));
    const unrelatedReader = renderCounted(() => Unrelated.useFind('unrelated-1'));
    const before = {
      root: rootReader.renders(),
      added: addedReader.renders(),
      changed: changedReader.renders(),
      removed: removedReader.renders(),
      unrelated: unrelatedReader.renders(),
      commits: diagnostics().snapshot().commits
    };

    await act(async () => {
      await Root.actions.apply.run({ value: 'input' });
    });

    expect(rootReader.result()).toEqual({ id: 'root-1', value: 'root' });
    expect(addedReader.result()).toEqual({ id: 'added-1', value: 'added' });
    expect(changedReader.result()).toEqual({ id: 'changed-1', value: 'changed' });
    expect(removedReader.result()).toBeUndefined();
    expect(rootReader.renders() - before.root).toBe(1);
    expect(addedReader.renders() - before.added).toBe(1);
    expect(changedReader.renders() - before.changed).toBe(1);
    expect(removedReader.renders() - before.removed).toBe(1);
    expect(unrelatedReader.renders() - before.unrelated).toBe(0);
    expect(diagnostics().snapshot().commits - before.commits).toBe(1);

    rootReader.unmount();
    addedReader.unmount();
    changedReader.unmount();
    removedReader.unmount();
    unrelatedReader.unmount();
  });

  it('lands update, non-optimistic insert, and custom-select roots without public write', async () => {
    type AutomaticInput = { id: string; value: string };
    let responseIndex = 0;
    const responseIds = ['automatic-update', 'automatic-insert', 'automatic-custom'];
    const transport = createMockTransport({
      mutation: async <TData,>() => ({
        data: {
          rootAction: {
            root: { id: responseIds[responseIndex++], value: 'root' }
          }
        } as TData
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });

    const Root = defineModel('SpecActionWritePlanAutomaticRoot', {
      schema: RowSchema,
      actions: owner => ({
        update: owner.gql.action(rootDocument, {
          mode: 'request',
          result: 'rootAction',
          variables: (input: AutomaticInput) => ({ input }),
          root: { insert: { select: ({ data }) => data.rootAction.root } }
        }),
        insert: owner.gql.action(rootDocument, {
          mode: 'request',
          result: 'rootAction',
          variables: (input: AutomaticInput) => ({ input }),
          root: { insert: { select: ({ data }) => data.rootAction.root } }
        }),
        custom: owner.gql.action(rootDocument, {
          mode: 'request',
          result: 'rootAction',
          variables: (input: AutomaticInput) => ({ input }),
          root: { insert: { select: ({ data }) => data.rootAction.root } }
        })
      })
    });

    await Root.actions.update.run({ id: 'input-update', value: 'update' });
    await Root.actions.insert.run({ id: 'input-insert', value: 'insert' });
    await Root.actions.custom.run({ id: 'input-custom', value: 'custom' });

    expect(Root.find('automatic-update')).toEqual({ id: 'automatic-update', value: 'root' });
    expect(Root.find('automatic-insert')).toEqual({ id: 'automatic-insert', value: 'root' });
    expect(Root.find('automatic-custom')).toEqual({ id: 'automatic-custom', value: 'root' });
  });

  it('does not duplicate root planning for an optimistic insert', async () => {
    const transport = createMockTransport({
      mutation: async <TData,>() => ({
        data: { rootAction: { root: { id: 'optimistic-server', value: 'server' } } } as TData
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });

    let tempId = '';
    let selectCalls = 0;
    const Root = defineModel('SpecActionWritePlanOptimisticRoot', {
      schema: RowSchema,
      maintenance: { dropTempRowsAfterMs: 60_000 },
      actions: owner => ({
        apply: owner.gql.action(rootDocument, {
          mode: 'request',
          result: 'rootAction',
          variables: (input: RootInput) => ({ input }),
          root: {
            insert: {
              select: ({ data }) => {
                selectCalls += 1;
                return data.rootAction.root;
              }
            }
          },
          optimistic: { root: { insert: { select: ({ tempId: operationTempId }) => {
            tempId = operationTempId;
            return { id: operationTempId, value: 'optimistic' };
          } } } }
        })
      })
    });
    diagnostics().reset();
    const beforeCommits = diagnostics().snapshot().commits;

    await Root.actions.apply.run({ value: 'input' });

    expect(selectCalls).toBe(1);
    expect(Root.find(tempId)).toBeUndefined();
    expect(Root.find('optimistic-server')).toEqual({ id: 'optimistic-server', value: 'server' });
    expect(diagnostics().snapshot().commits - beforeCommits).toBe(2);
  });
});
