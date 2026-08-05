import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { configureDb, defineModel, defineShape, f, getCommitBus, resetRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

type Row = { id: string; value: string };
type Scope = { bucket: string };
type QueryResponse = { root: Row };
type QueryVariables = Scope;
type ActionInput = { value: string };
type ActionResponse = { rootAction: { root: Row } };
type ActionVariables = { input: ActionInput };

const queryDocument: TypedDocumentNode<QueryResponse, QueryVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const actionDocument: TypedDocumentNode<ActionResponse, ActionVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const RowSchema = defineShape<Row>()({ value: f.str() });

describe('write plan safety', () => {
  it('[OP16] drops a query response when write resets the runtime', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { root: { id: 'root-query-reset', value: 'root' } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });

    const Sibling = defineModel('SpecWritePlanSafetyQuerySibling', { schema: RowSchema });
    let invalidations = 0;
    const target = { invalidate: () => invalidations++ };
    const Root = defineModel('SpecWritePlanSafetyQueryRoot', {
      schema: RowSchema,
      relations: owner => ({
        root: {
          remote: owner.gql.single(queryDocument, {
            variables: (params: Scope) => params,
            select: data => data.root,
            write: (_context, plan) => {
              plan.upsert(Sibling, { id: 'sibling-query-reset', value: 'sibling' });
              plan.invalidate(target);
              resetRuntime();
            }
          })
        }
      })
    });

    await expect(Root.root({ bucket: 'all' }).fetch()).rejects.toThrow('response dropped');

    expect(Root.find('root-query-reset')).toBeUndefined();
    expect(Sibling.find('sibling-query-reset')).toBeUndefined();
    expect(invalidations).toBe(0);
  });

  it('returns null when action write resets the runtime', async () => {
    const transport = createMockTransport({
      mutation: async <TData,>() => ({ data: { rootAction: { root: { id: 'root-action-reset', value: 'root' } } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });

    const Sibling = defineModel('SpecWritePlanSafetyActionSibling', { schema: RowSchema });
    let invalidations = 0;
    const target = { invalidate: () => invalidations++ };
    const Root = defineModel('SpecWritePlanSafetyActionRoot', {
      schema: RowSchema,
      actions: owner => ({
        apply: owner.gql.action(actionDocument, {
          mode: 'request',
          result: 'rootAction',
          variables: (input: ActionInput) => ({ input }),
          root: { insert: { select: ({ data }) => data.rootAction.root } },
          write: (_context, plan) => {
            plan.upsert(Sibling, { id: 'sibling-action-reset', value: 'sibling' });
            plan.invalidate(target);
            resetRuntime();
          }
        })
      })
    });

    const result = await Root.actions.apply.run({ value: 'input' });

    expect(result).toBeNull();
    expect(Root.find('root-action-reset')).toBeUndefined();
    expect(Sibling.find('sibling-action-reset')).toBeUndefined();
    expect(invalidations).toBe(0);
  });

  it('drops query persistence and invalidations when commit subscribers reset the runtime', async () => {
    const storage = createMemoryPlane();
    let queryPersistenceWrites = 0;
    const storageSet = storage.set;
    storage.set = (key, value) => {
      if (value !== null && key.includes(':query:')) queryPersistenceWrites += 1;
      storageSet(key, value);
    };
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { root: { id: 'root-commit-reset', value: 'root' } } as TData })
    });
    configureDb({ storage, transport });

    const Sibling = defineModel('SpecWritePlanSafetyCommitSibling', { schema: RowSchema });
    let invalidations = 0;
    const target = { invalidate: () => invalidations++ };
    const Root = defineModel('SpecWritePlanSafetyCommitRoot', {
      schema: RowSchema,
      relations: owner => ({
        root: {
          remote: owner.gql.single(queryDocument, {
            variables: (params: Scope) => params,
            select: data => data.root,
            staleTime: 60_000,
            write: (_context, plan) => {
              plan.upsert(Sibling, { id: 'sibling-commit-reset', value: 'sibling' });
              plan.invalidate(target);
            }
          })
        }
      })
    });
    const unsubscribe = getCommitBus().subscribeAll(() => resetRuntime());

    try {
      await expect(Root.root({ bucket: 'all' }).fetch()).rejects.toThrow('response dropped');
    } finally {
      unsubscribe();
    }

    expect(Root.find('root-commit-reset')).toBeUndefined();
    expect(Sibling.find('sibling-commit-reset')).toBeUndefined();
    expect(invalidations).toBe(0);
    expect(queryPersistenceWrites).toBe(0);
  });

  it('stops invalidations and track after the first target resets the runtime', async () => {
    const transport = createMockTransport({
      mutation: async <TData,>() => ({ data: { rootAction: { root: { id: 'root-invalidation-reset', value: 'root' } } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });

    const Sibling = defineModel('SpecWritePlanSafetyInvalidationSibling', { schema: RowSchema });
    let firstInvalidations = 0;
    let secondInvalidations = 0;
    let tracks = 0;
    const firstTarget = {
      invalidate: () => {
        firstInvalidations += 1;
        resetRuntime();
      }
    };
    const secondTarget = { invalidate: () => secondInvalidations++ };
    const Root = defineModel('SpecWritePlanSafetyInvalidationRoot', {
      schema: RowSchema,
      actions: owner => ({
        apply: owner.gql.action(actionDocument, {
          mode: 'request',
          result: 'rootAction',
          variables: (input: ActionInput) => ({ input }),
          root: { insert: { select: ({ data }) => data.rootAction.root } },
          track: () => {
            tracks += 1;
          },
          write: (_context, plan) => {
            plan.upsert(Sibling, { id: 'sibling-invalidation-reset', value: 'sibling' });
            plan.invalidate(firstTarget);
            plan.invalidate(secondTarget);
          }
        })
      })
    });

    const result = await Root.actions.apply.run({ value: 'input' });

    expect(result).toBeNull();
    expect(firstInvalidations).toBe(1);
    expect(secondInvalidations).toBe(0);
    expect(tracks).toBe(0);
    expect(Root.find('root-invalidation-reset')).toBeUndefined();
    expect(Sibling.find('sibling-invalidation-reset')).toBeUndefined();
  });

  it('accepts a registered runtime target for a write plan', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { root: { id: 'root-runtime-target', value: 'root' } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });

    const RuntimeSibling = defineModel('SpecWritePlanSafetyRuntimeSibling', { schema: RowSchema });
    const Root = defineModel('SpecWritePlanSafetyRuntimeRoot', {
      schema: RowSchema,
      relations: owner => ({
        root: {
          remote: owner.gql.single(queryDocument, {
            variables: (params: Scope) => params,
            select: data => data.root,
            write: (_context, plan) => {
              plan.upsert(RuntimeSibling, { id: 'runtime-sibling', value: 'runtime' });
            }
          })
        }
      })
    });

    await Root.root({ bucket: 'all' }).fetch();

    expect(RuntimeSibling.find('runtime-sibling')).toEqual({ id: 'runtime-sibling', value: 'runtime' });
  });

  it('rejects forged update and destroy targets before committing the root response', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { root: { id: 'root-forged-target', value: 'root' } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });

    const Victim = defineModel('SpecWritePlanSafetyVictim', { schema: RowSchema });
    Victim.insert({ id: 'victim-update', value: 'before-update' });
    Victim.insert({ id: 'victim-destroy', value: 'before-destroy' });
    const forgedTarget: { readonly key: string; build(input: Row): Row } = { key: Victim.key, build: Victim.build };
    const RootUpdate = defineModel('SpecWritePlanSafetyForgedUpdateRoot', {
      schema: RowSchema,
      relations: owner => ({
        updateRoot: {
          remote: owner.gql.single(queryDocument, {
            variables: (params: Scope) => params,
            select: data => data.root,
            write: (_context, plan) => {
              plan.update(forgedTarget, 'victim-update', { value: 'forged-update' });
            }
          })
        }
      })
    });
    const RootDestroy = defineModel('SpecWritePlanSafetyForgedDestroyRoot', {
      schema: RowSchema,
      relations: owner => ({
        destroyRoot: {
          remote: owner.gql.single(queryDocument, {
            variables: (params: Scope) => params,
            select: data => data.root,
            write: (_context, plan) => {
              plan.destroy(forgedTarget, 'victim-destroy');
            }
          })
        }
      })
    });

    await expect(RootUpdate.updateRoot({ bucket: 'all' }).fetch()).rejects.toThrow('Unknown model handle');
    await expect(RootDestroy.destroyRoot({ bucket: 'all' }).fetch()).rejects.toThrow('Unknown model handle');

    expect(Victim.find('victim-update')).toEqual({ id: 'victim-update', value: 'before-update' });
    expect(Victim.find('victim-destroy')).toEqual({ id: 'victim-destroy', value: 'before-destroy' });
    expect(RootUpdate.find('root-forged-target')).toBeUndefined();
    expect(RootDestroy.find('root-forged-target')).toBeUndefined();
  });

  it('[W17] rejects undefined update patches before committing the root response', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { root: { id: 'root-undefined', value: 'root' } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });

    const Victim = defineModel('SpecWritePlanSafetyUndefinedVictim', { schema: RowSchema });
    Victim.insert({ id: 'victim-undefined', value: 'before' });
    let invalidations = 0;
    const target = { invalidate: () => invalidations++ };
    const Root = defineModel('SpecWritePlanSafetyUndefinedRoot', {
      schema: RowSchema,
      relations: owner => ({
        root: {
          remote: owner.gql.single(queryDocument, {
            variables: (params: Scope) => params,
            select: data => data.root,
            write: (_context, plan) => {
              plan.update(Victim, 'victim-undefined', { value: undefined });
              plan.invalidate(target);
            }
          })
        }
      })
    });

    await expect(Root.root({ bucket: 'all' }).fetch()).rejects.toThrow('WritePlan.update does not accept undefined for "value"');

    expect(Root.find('root-undefined')).toBeUndefined();
    expect(Victim.find('victim-undefined')).toEqual({ id: 'victim-undefined', value: 'before' });
    expect(invalidations).toBe(0);
  });
});
