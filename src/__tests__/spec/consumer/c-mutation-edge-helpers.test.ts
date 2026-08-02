import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import {
  configureDb,
  correlateIncomingRow,
  createMutationResponder,
  defineModelRuntime,
  exactMutationRootPlan,
  f,
  getOperationState,
  getInternalModelHandle,
  hasMany,
  isMethodOptimistic,
  isRespondOptimistic,
  modelHasCorrelators,
  registerBootValidation,
  registerMutationCorrelator,
  runBootValidations,
  validateMutationConfig
} from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

const document = { kind: 'Document', definitions: [] } as never;
type RootPlanResponse = { save: { row: { id: string; label: string } } };
type RootPlanVariables = { input: { label: string } };
const rootPlanDocument: TypedDocumentNode<RootPlanResponse, RootPlanVariables> = { kind: Kind.DOCUMENT, definitions: [] };

describe('mutation configuration edges', () => {
  it('rejects conflicting declaration shapes and invalid optimistic placement', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const plain = defineModelRuntime({
      id: 'MutationConfigPlain',
      name: 'MutationConfigPlain',
      fields: { label: f.str() }
    });
    const maintained = defineModelRuntime({
      id: 'MutationConfigMaintained',
      name: 'MutationConfigMaintained',
      fields: { label: f.str() },
      maintenance: { dropTempRowsAfterMs: 1000 },
      scopes: {
        sorted: ({ sort: { field: 'label', dir: 'asc' } }),
        server: ({ sort: 'server-order' })
      }
    });
    const other = defineModelRuntime({
      id: 'MutationConfigOther',
      name: 'MutationConfigOther',
      fields: { label: f.str() },
      scopes: { server: ({ sort: 'server-order' }) }
    });

    expect(isMethodOptimistic({ model: plain, method: 'patch', id: () => 'row-1', patch: () => ({}) } as never)).toBe(true);
    expect(isRespondOptimistic({ model: plain, respond: () => ({}) } as never)).toBe(true);
    expect(() => validateMutationConfig({ document, result: 'save', once: true, dedupe: false } as never)).toThrow(
      'once cannot be combined with dedupe: false'
    );
    expect(() =>
      validateMutationConfig({
        document,
        result: 'save',
        optimistic: { model: plain, respond: () => ({}), build: () => ({}) }
      } as never)
    ).toThrow('optimistic respond cannot be combined with build or method');
    expect(() =>
      validateMutationConfig({
        document,
        result: 'save',
        optimistic: { model: plain, method: 'patch', id: () => 'row-1', patch: () => ({}), prependTo: {} }
      } as never)
    ).toThrow('optimistic prependTo/appendTo requires an insert optimistic config');
    expect(() =>
      validateMutationConfig({
        document,
        result: 'save',
        optimistic: { model: plain, build: () => ({ id: 'temp-row' }), selectServerNode: () => null }
      } as never)
    ).toThrow('MutationConfigPlain must declare maintenance.dropTempRowsAfterMs');
    expect(() =>
      validateMutationConfig({
        document,
        result: 'save',
        optimistic: {
          model: maintained,
          build: () => ({ id: 'temp-row' }),
          selectServerNode: () => null,
          prependTo: { scope: maintained.scopes.server, value: () => ({}) },
          appendTo: { scope: maintained.scopes.server, value: () => ({}) }
        }
      } as never)
    ).toThrow('optimistic prependTo and appendTo are mutually exclusive');
    expect(() =>
      validateMutationConfig({
        document,
        result: 'save',
        optimistic: {
          model: maintained,
          build: () => ({ id: 'temp-row' }),
          selectServerNode: () => null,
          prependTo: { scope: maintained.scopes.sorted, value: () => ({}) }
        }
      } as never)
    ).toThrow('optimistic prependTo/appendTo requires a server-order scope');
    expect(() =>
      validateMutationConfig({
        document,
        result: 'save',
        optimistic: {
          model: maintained,
          build: () => ({ id: 'temp-row' }),
          selectServerNode: () => null,
          prependTo: { scope: other.scopes.server, value: () => ({}) }
        }
      } as never)
    ).toThrow('optimistic prependTo/appendTo scope must belong to the optimistic model');
  });

  it('rejects optimistic destroy when a dependent cascade makes rollback incomplete', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const child = defineModelRuntime({
      id: 'MutationConfigCascadeChild',
      name: 'MutationConfigCascadeChild',
      fields: { parentId: f.id() }
    });
    const parent = defineModelRuntime({
      id: 'MutationConfigCascadeParent',
      name: 'MutationConfigCascadeParent',
      fields: { label: f.str() },
      relations: () => ({ children: hasMany(child, { foreignKey: 'parentId', dependent: 'destroy' }) })
    });
    const validationKey = `optimistic-destroy-cascade:${parent.modelId}`;

    try {
      validateMutationConfig({
        document,
        result: 'destroy',
        optimistic: { model: parent, method: 'destroy', id: () => 'parent-1' }
      } as never);
      expect(() => runBootValidations()).toThrow(
        'MutationConfigCascadeParent: optimistic destroy is not supported on models with dependent cascades'
      );
    } finally {
      registerBootValidation(validationKey, () => undefined);
    }
  });
});

describe('mutation correlation edges', () => {
  it('filters invalid candidates and picks the oldest matching open operation deterministically', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineModelRuntime({
      id: 'MutationCorrelationEdges',
      name: 'MutationCorrelationEdges',
      fields: {
        text: f.str(),
        createdAt: f.custom<unknown, { createdAt?: unknown }>(input => input.createdAt),
        allowed: f.custom<unknown, { allowed?: unknown }>(input => input.allowed)
      }
    });
    expect(modelHasCorrelators(rows.modelId)).toBe(false);
    expect(correlateIncomingRow(rows.modelId, { id: 'server-1' }, { readRow: id => rows.find(id), claimedTempIds: new Set() })).toBeNull();
    registerMutationCorrelator(rows.modelId, 'send', {
      fields: ['text'],
      match: candidate => candidate.allowed === true,
      createdAtWindowMs: 10
    });
    expect(modelHasCorrelators(rows.modelId)).toBe(true);
    expect(correlateIncomingRow(rows.modelId, { id: 'temp-server-1' }, { readRow: id => rows.find(id), claimedTempIds: new Set() })).toBeNull();
    rows.insert({ id: 'server-existing', text: 'same', createdAt: 100, allowed: true });
    expect(
      correlateIncomingRow(rows.modelId, { id: 'server-existing', text: 'same' }, { readRow: id => rows.find(id), claimedTempIds: new Set() })
    ).toBeNull();

    const candidates = [
      { operationId: 'empty', tempIds: [], createdAt: 0 },
      { operationId: 'claimed', tempIds: ['temp-claimed'], createdAt: 1 },
      { operationId: 'missing', tempIds: ['temp-missing'], createdAt: 2 },
      { operationId: 'field', tempIds: ['temp-field'], createdAt: 3 },
      { operationId: 'match', tempIds: ['temp-match'], createdAt: 4 },
      { operationId: 'time', tempIds: ['temp-time'], createdAt: 5 },
      { operationId: 'time-object', tempIds: ['temp-time-object'], createdAt: 5 },
      { operationId: 'z-valid', tempIds: ['temp-z'], createdAt: 6 },
      { operationId: 'a-valid', tempIds: ['temp-a'], createdAt: 6 }
    ];
    for (const candidate of candidates) {
      getOperationState().begin({
        operationId: candidate.operationId,
        model: rows.modelId,
        tempIds: candidate.tempIds,
        rowIds: candidate.tempIds,
        intent: 'insert',
        createdAt: candidate.createdAt
      });
    }
    rows.insertMany([
      { id: 'temp-claimed', text: 'same', createdAt: 100, allowed: true },
      { id: 'temp-field', text: 'different', createdAt: 100, allowed: true },
      { id: 'temp-match', text: 'same', createdAt: 100, allowed: false },
      { id: 'temp-time', text: 'same', createdAt: 'invalid', allowed: true },
      { id: 'temp-time-object', text: 'same', createdAt: {}, allowed: true },
      { id: 'temp-z', text: 'same', createdAt: new Date(100).toISOString(), allowed: true },
      { id: 'temp-a', text: 'same', createdAt: 100, allowed: true }
    ]);

    expect(
      correlateIncomingRow(
        rows.modelId,
        { id: 'server-new', text: 'same', createdAt: new Date(105), allowed: true },
        { readRow: id => rows.find(id), claimedTempIds: new Set(['temp-claimed']) }
      )
    ).toMatchObject({ tempId: 'temp-a', operation: { operationId: 'a-valid' } });
  });
});

describe('mutation root planner edges', () => {
  it('applies the exact root planner output before the response commit', async () => {
    const transport = createMockTransport({
      mutation: async <TData,>() => ({
        data: { save: { row: { id: 'root-plan-1', label: 'root' } } } as TData
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const root = defineModelRuntime({
      id: 'MutationRootPlanEdges',
      name: 'MutationRootPlanEdges',
      fields: { label: f.str() }
    });
    const mutation = root.mutation('save', {
      document: rootPlanDocument,
      result: 'save',
      [exactMutationRootPlan]: ({ data }) => getInternalModelHandle(root).planRows([data.save.row])
    });

    await mutation.run({ label: 'input' });

    expect(root.find('root-plan-1')).toEqual({ id: 'root-plan-1', label: 'root' });
  });
});

describe('mutation responder edges', () => {
  it('uses model rowId normalization for replacement and inverse identities', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineModelRuntime({
      id: 'MutationResponderCustomIds',
      name: 'MutationResponderCustomIds',
      fields: { label: f.str() },
      rowId: input => (input as { sourceId: string | number }).sourceId,
      guard: input => (input as { label?: string }).label !== 'guarded',
      maintenance: { dropTempRowsAfterMs: 1000 }
    });
    const optimistic = {
      model: rows,
      respond: () => ({}),
      selectServerNode: (data: { save: { row: { sourceId: number; label: string } } }) => data.save.row
    };
    const responder = createMutationResponder({ document, result: 'save', optimistic } as never);
    const context = { tempId: 'temp-1', operationId: 'operation-1' };
    rows.insert({ sourceId: 'temp-1', label: 'temporary' } as never);

    expect(() =>
      responder.planFromRespond(
        { save: { row: { sourceId: null, label: 'invalid' } } } as never,
        { tempId: null, operationId: 'invalid-operation' },
        optimistic as never,
        {}
      )
    ).toThrow('MutationResponderCustomIds requires id');
    expect(() =>
      responder.planFromRespond(
        { save: { row: { id: 'wrong-field', sourceId: 77, label: 'guarded' } } } as never,
        context,
        optimistic as never,
        {}
      )
    ).toThrow('MutationResponderCustomIds rejected input');

    const response = { save: { row: { sourceId: 77, label: 'server' } } };
    const plan = responder.planFromRespond(response as never, context, optimistic as never, {});
    const inverse = responder.inverseFromRespond(response as never, context, optimistic as never);

    expect(plan).toContainEqual({ kind: 'destroy', model: rows.modelId, ids: ['temp-1'], origin: 'replace' });
    expect(inverse).toContainEqual({ kind: 'destroy', model: rows.modelId, ids: ['77'], tombstone: false });
  });

  it('plans absent payload errors, temp placement, replacement, and inverse writes', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineModelRuntime({
      id: 'MutationResponderRows',
      name: 'MutationResponderRows',
      fields: { label: f.str() },
      maintenance: { dropTempRowsAfterMs: 1000 },
      scopes: { feed: ({ sort: 'server-order' }) }
    });
    const optimistic = {
      model: rows,
      respond: () => ({}),
      selectServerNode: (data: { save: { row: { id?: string; label: string } | null } }) => data.save.row,
      prependTo: { scope: rows.scopes.feed, value: () => ({}) }
    };
    const responder = createMutationResponder({ document, result: 'save', optimistic } as never);
    const context = { tempId: 'temp-1', operationId: 'operation-1' };

    expect(() => responder.planFromRespond({} as never, context, optimistic as never, {})).toThrow('save returned no data');
    expect(responder.planFromRespond({ save: { row: null } } as never, context, optimistic as never, {})).toEqual([]);
    const tempPlan = responder.planFromRespond(
      { save: { row: { id: '', label: 'temp' } } } as never,
      context,
      optimistic as never,
      {}
    );
    expect(tempPlan.some(op => op.kind === 'scope-delta')).toBe(true);
    expect(
      responder.planFromRespond(
        { save: { row: { id: 'server-direct', label: 'direct' } } } as never,
        { tempId: null, operationId: 'operation-direct' },
        optimistic as never,
        {}
      )
    ).toContainEqual({ kind: 'upsert', model: rows.modelId, rows: [{ id: 'server-direct', label: 'direct' }] });

    const appendOptimistic = { ...optimistic, prependTo: undefined, appendTo: { scope: rows.scopes.feed, value: () => ({}) } };
    expect(responder.planFromRespond({ save: { row: { id: '', label: 'append' } } } as never, context, appendOptimistic as never, {})).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'scope-delta' })])
    );

    rows.insert({ id: 'temp-1', label: 'old' });
    const replacement = responder.planFromRespond(
      { save: { row: { id: 'server-1', label: 'server' } } } as never,
      context,
      optimistic as never,
      {}
    );
    expect(replacement).toContainEqual({ kind: 'destroy', model: rows.modelId, ids: ['temp-1'], origin: 'replace' });

    const inverse = responder.inverseFromRespond(
      { save: { row: { id: 'server-new', label: 'new' } } } as never,
      context,
      optimistic as never
    );
    expect(inverse).toContainEqual({ kind: 'destroy', model: rows.modelId, ids: ['server-new'], tombstone: false });
    expect(
      responder.inverseFromRespond(
        { save: { row: { id: '', label: 'temp' } } } as never,
        context,
        optimistic as never
      )
    ).toContainEqual(expect.objectContaining({ model: rows.modelId }));

    expect(responder.planFromRespond({ save: { row: null } } as never, context, optimistic as never, {})).toEqual([]);
    expect(responder.inverseFromRespond({ save: { row: null } } as never, context, optimistic as never)).toEqual([]);
  });
});
