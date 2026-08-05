import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind, OperationTypeNode } from 'graphql';
import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import {
  advanceRuntimeGeneration,
  configureDb,
  defineModel,
  defineShape,
  f,
  resetRuntime,
  type DbTransport,
  useDbSubscriptions
} from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted, settle } from '../helpers/harness';

type ObjectValue = Record<string, string | number>;
type Row = {
  id: string;
  protectedValue: string;
  auxiliaryValue: string;
  version: number;
  localValue: string;
  continuityValue: string;
  snapshotValue: ObjectValue;
  keyedValue: ObjectValue;
};
type ScopeValue = { request: string };
type QueryResponse = { row: Row };
type LivePayload = { row: Row };
type LiveData = { changed: LivePayload };
type DeferredResponse = {
  resolve(response: QueryResponse): void;
  reject(error: Error): void;
};
type Subscriber = {
  handlers: { next(data: unknown): void; error(error: unknown): void };
  unsubscribe: jest.Mock;
};

type ExistenceRow = { id: string; value: string };
type ExistenceVariables = { input: { id: string } };
type DestroyData = { destroyRow: { ok: boolean } };
type InsertData = { insertRow: { row: ExistenceRow } };
type DeferredMutation<TData> = {
  resolve(response: TData): void;
  reject(error: Error): void;
};

const RowSchema = defineShape<Row>()({
  protectedValue: f.str(),
  auxiliaryValue: f.str(),
  version: f.num(),
  localValue: f.str(),
  continuityValue: f.str(),
  snapshotValue: f.raw<ObjectValue>(),
  keyedValue: f.raw<ObjectValue>()
});
const UnrelatedSchema = defineShape<{ id: string; value: string }>()({ value: f.str() });
const ExistenceSchema = defineShape<ExistenceRow>()({ value: f.str() });

const queryDocument: TypedDocumentNode<QueryResponse, ScopeValue> = { kind: Kind.DOCUMENT, definitions: [] };
const destroyDocument: TypedDocumentNode<DestroyData, ExistenceVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const insertDocument: TypedDocumentNode<InsertData, ExistenceVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const liveDocument: TypedDocumentNode<LiveData, Record<string, never>> = {
  kind: Kind.DOCUMENT,
  definitions: [
    {
      kind: Kind.OPERATION_DEFINITION,
      operation: OperationTypeNode.SUBSCRIPTION,
      variableDefinitions: [],
      directives: [],
      selectionSet: {
        kind: Kind.SELECTION_SET,
        selections: [
          {
            kind: Kind.FIELD,
            name: { kind: Kind.NAME, value: 'changed' },
            arguments: [],
            directives: []
          }
        ]
      }
    }
  ]
};

const initialRow = (): Row => ({
  id: 'row-1',
  protectedValue: 'base',
  auxiliaryValue: 'base-auxiliary',
  version: 1,
  localValue: 'base-local',
  continuityValue: 'base-continuity',
  snapshotValue: { retained: 'base', replaced: 'base' },
  keyedValue: { retained: 'base', replaced: 'base' }
});

const activationRoots = new Set<TestRenderer.ReactTestRenderer>();

function SubscriptionActivation(): null {
  useDbSubscriptions(true);
  return null;
}

const activateSubscriptions = (): void => {
  let root!: TestRenderer.ReactTestRenderer;
  act(() => {
    root = TestRenderer.create(React.createElement(SubscriptionActivation));
  });
  activationRoots.add(root);
};

afterEach(() => {
  act(() => {
    for (const root of activationRoots) root.unmount();
  });
  activationRoots.clear();
  resetRuntime();
});

const createFieldFixture = (suffix: string, withPolicies = false) => {
  const deferred = new Map<string, DeferredResponse>();
  const subscribers: Subscriber[] = [];
  const storage = createMemoryPlane();
  const transport = createMockTransport({
    query: async <TData,>(operation: Parameters<DbTransport['query']>[0]) =>
      await new Promise<{ data: TData }>((resolve, reject) => {
        const request = (operation.variables as ScopeValue).request;
        deferred.set(request, {
          resolve: response => resolve({ data: response as TData }),
          reject
        });
      }),
    subscribe: (_options, handlers) => {
      const unsubscribe = jest.fn();
      subscribers.push({ handlers, unsubscribe });
      return unsubscribe;
    }
  });
  configureDb({ storage, transport });

  const rows = defineModel(`SpecCausalAdmission${suffix}`, {
    schema: RowSchema,
    ...(withPolicies
      ? {
          write: {
            groups: [
              { fields: ['protectedValue'] as const, policy: 'server' as const },
              {
                fields: ['version'] as const,
                policy: { monotonic: { tuple: ['version'] as [string] } }
              },
              { fields: ['localValue'] as const, policy: 'local' as const },
              { fields: ['continuityValue'] as const, policy: 'continuity' as const },
              { fields: ['snapshotValue'] as const, policy: { snapshot: true as const } },
              {
                fields: ['keyedValue'] as const,
                policy: { keys: { replaced: 'server' as const }, rest: 'continuity' as const }
              }
            ]
          }
        }
      : {}),
    relations: owner => ({
      remote: {
        remote: owner.gql.single(queryDocument, {
          variables: (params: ScopeValue) => params,
          select: data => data.row
        })
      }
    }),
    events: owner => ({
      changed: owner.gql.live(liveDocument, {
        variables: {},
        root: {
          insert: {
            select: context => context.payload.row
          }
        }
      })
    })
  });
  const unrelated = defineModel(`SpecCausalAdmissionUnrelated${suffix}`, { schema: UnrelatedSchema });
  rows.insert(initialRow());
  unrelated.insert({ id: 'unrelated-1', value: 'unchanged' });
  activateSubscriptions();

  const affectedReader = renderCounted(() => rows.useFind('row-1'));
  const unrelatedReader = renderCounted(() => unrelated.useFind('unrelated-1'));
  const baseline = {
    affectedTicks: affectedReader.renders(),
    unrelatedTicks: unrelatedReader.renders()
  };

  const start = async (name: string): Promise<{ pending: Promise<void> }> => {
    const pending = rows.remote({ request: name }).fetch();
    await settle();
    expect(deferred.has(name)).toBe(true);
    return { pending };
  };
  const resolve = async (name: string, row: Row, pending: Promise<void>): Promise<void> => {
    const landing = deferred.get(name);
    expect(landing).toBeDefined();
    await act(async () => {
      landing!.resolve({ row });
      await pending;
    });
  };
  const emitLive = (row: Row): void => {
    const subscriber = subscribers.at(-1);
    expect(subscriber).toBeDefined();
    expect(subscriber!.unsubscribe).not.toHaveBeenCalled();
    act(() => {
      subscriber!.handlers.next({ changed: { row } });
    });
  };
  const assertOutcome = (expected: Row, affectedTicks: number): void => {
    expect(rows.find('row-1')).toEqual(expected);

    expect(affectedReader.renders() - baseline.affectedTicks).toBe(affectedTicks);
    expect(unrelatedReader.renders() - baseline.unrelatedTicks).toBe(0);
    expect(unrelated.find('unrelated-1')).toEqual({ id: 'unrelated-1', value: 'unchanged' });
  };
  const unmount = (): void => {
    affectedReader.unmount();
    unrelatedReader.unmount();
  };

  return { rows, start, resolve, emitLive, assertOutcome, unmount };
};

describe('causal write admission', () => {
  it('keeps the later response when an earlier response lands last', async () => {
    const fixture = createFieldFixture('EarlierAfterLater');
    const { pending: earlier } = await fixture.start('earlier');
    const { pending: later } = await fixture.start('later');
    const laterRow = { ...initialRow(), protectedValue: 'later-response' };

    await fixture.resolve('later', laterRow, later);
    await fixture.resolve('earlier', { ...initialRow(), protectedValue: 'earlier-response' }, earlier);

    fixture.assertOutcome(laterRow, 1);
    fixture.unmount();
  });

  it('keeps a live field commit when a slow response lands afterward', async () => {
    const fixture = createFieldFixture('ResponseAfterLive');
    const { pending: slow } = await fixture.start('slow');
    const liveRow = { ...initialRow(), protectedValue: 'live' };

    fixture.emitLive(liveRow);
    await fixture.resolve('slow', { ...initialRow(), protectedValue: 'slow-response' }, slow);

    fixture.assertOutcome(liveRow, 1);
    fixture.unmount();
  });

  it('keeps a local field commit when a slow response lands afterward', async () => {
    const fixture = createFieldFixture('ResponseAfterLocal');
    const { pending: slow } = await fixture.start('slow');
    const expected = { ...initialRow(), protectedValue: 'local' };

    act(() => {
      fixture.rows.update('row-1', { protectedValue: 'local' });
    });
    await fixture.resolve('slow', { ...initialRow(), protectedValue: 'slow-response' }, slow);

    fixture.assertOutcome(expected, 1);
    fixture.unmount();
  });

  it('admits a duplicated response at most once', async () => {
    const fixture = createFieldFixture('DuplicateResponse');
    const { pending: first } = await fixture.start('first');
    const { pending: duplicate } = await fixture.start('duplicate');
    const response = { ...initialRow(), protectedValue: 'response' };

    await fixture.resolve('first', response, first);
    await fixture.resolve('duplicate', response, duplicate);

    fixture.assertOutcome(response, 1);
    fixture.unmount();
  });

  it('drops a response from an earlier reset generation', async () => {
    const fixture = createFieldFixture('ResetGeneration');
    const { pending: slow } = await fixture.start('slow');

    advanceRuntimeGeneration();
    await expect(fixture.resolve('slow', { ...initialRow(), protectedValue: 'stale-generation' }, slow)).rejects.toThrow(
      'runtime was reset before it resolved'
    );

    fixture.assertOutcome(initialRow(), 0);
    fixture.unmount();
  });

  it('runs causal admission before server, monotonic, local, continuity, snapshot, and keys policies', async () => {
    const fixture = createFieldFixture('PolicyOrder', true);
    const { pending: slow } = await fixture.start('slow');
    const expected: Row = {
      ...initialRow(),
      protectedValue: 'post-base-server',
      auxiliaryValue: 'post-base-auxiliary',
      version: 2,
      localValue: 'post-base-local',
      continuityValue: 'post-base-continuity',
      snapshotValue: { retained: 'post-base', replaced: 'post-base' },
      keyedValue: { retained: 'post-base', replaced: 'post-base' }
    };

    act(() => {
      fixture.rows.update('row-1', expected);
    });
    await fixture.resolve(
      'slow',
      {
        ...initialRow(),
        protectedValue: 'slow-server',
        auxiliaryValue: 'slow-auxiliary',
        version: 3,
        localValue: 'slow-local',
        continuityValue: 'slow-continuity',
        snapshotValue: { retained: 'slow', replaced: 'slow' },
        keyedValue: { retained: 'slow', replaced: 'slow' }
      },
      slow
    );

    fixture.assertOutcome(expected, 1);
    fixture.unmount();
  });

  it('protects only fields committed after the base and admits an unrelated slow-response field', async () => {
    const fixture = createFieldFixture('PartialResponse');
    const { pending: slow } = await fixture.start('slow');
    const expected = { ...initialRow(), protectedValue: 'post-base', auxiliaryValue: 'slow-auxiliary' };

    act(() => {
      fixture.rows.update('row-1', { protectedValue: 'post-base' });
    });
    await fixture.resolve(
      'slow',
      { ...initialRow(), protectedValue: 'slow-protected', auxiliaryValue: 'slow-auxiliary' },
      slow
    );

    fixture.assertOutcome(expected, 2);
    fixture.unmount();
  });

  it('drops a slow remote destroy after a later local update', async () => {
    let deferred: DeferredMutation<DestroyData> | undefined;
    const storage = createMemoryPlane();
    const transport = createMockTransport({
      mutation: async <TData,>() =>
        await new Promise<{ data: TData }>((resolve, reject) => {
          deferred = {
            resolve: response => resolve({ data: response as TData }),
            reject
          };
        })
    });
    configureDb({ storage, transport });
    const model = defineModel('SpecCausalExistenceDestroyAfterUpdate', {
      schema: ExistenceSchema,
      actions: owner => ({
        remote: owner.gql.action(destroyDocument, {
          result: 'destroyRow',
          variables: input => ({ input }),
          root: { destroy: { select: context => context.input.id } }
        })
      })
    });
    const unrelated = defineModel('SpecCausalExistenceUnrelatedDestroyAfterUpdate', { schema: ExistenceSchema });
    model.insert({ id: 'row-1', value: 'before' });
    unrelated.insert({ id: 'unrelated-1', value: 'unchanged' });
    const affectedReader = renderCounted(() => model.useFind('row-1'));
    const unrelatedReader = renderCounted(() => unrelated.useFind('unrelated-1'));
    const pending = model.actions.remote.run({ id: 'row-1' });
    await settle();
    expect(deferred).toBeDefined();

    act(() => {
      model.update('row-1', { value: 'later-local' });
    });
    const baseline = {
  
      affectedTicks: affectedReader.renders(),
      unrelatedTicks: unrelatedReader.renders()
    };
    await act(async () => {
      deferred!.resolve({ destroyRow: { ok: true } });
      await pending;
    });

    expect(model.find('row-1')).toEqual({ id: 'row-1', value: 'later-local' });

    expect(affectedReader.renders() - baseline.affectedTicks).toBe(0);
    expect(unrelatedReader.renders() - baseline.unrelatedTicks).toBe(0);
    expect(unrelated.find('unrelated-1')).toEqual({ id: 'unrelated-1', value: 'unchanged' });
    affectedReader.unmount();
    unrelatedReader.unmount();
  });

  it('does not resurrect a row when a slow remote insert lands after a later local insert and destroy', async () => {
    let deferred: DeferredMutation<InsertData> | undefined;
    const storage = createMemoryPlane();
    const transport = createMockTransport({
      mutation: async <TData,>() =>
        await new Promise<{ data: TData }>((resolve, reject) => {
          deferred = {
            resolve: response => resolve({ data: response as TData }),
            reject
          };
        })
    });
    configureDb({ storage, transport });
    const model = defineModel('SpecCausalExistenceInsertAfterDestroy', {
      schema: ExistenceSchema,
      actions: owner => ({
        remote: owner.gql.action(insertDocument, {
          result: 'insertRow',
          variables: input => ({ input }),
          root: { insert: { select: context => context.data.insertRow.row } }
        })
      })
    });
    const unrelated = defineModel('SpecCausalExistenceUnrelatedInsertAfterDestroy', { schema: ExistenceSchema });
    unrelated.insert({ id: 'unrelated-1', value: 'unchanged' });
    const affectedReader = renderCounted(() => model.useFind('row-1'));
    const unrelatedReader = renderCounted(() => unrelated.useFind('unrelated-1'));
    const pending = model.actions.remote.run({ id: 'row-1' });
    await settle();
    expect(deferred).toBeDefined();

    act(() => {
      model.insert({ id: 'row-1', value: 'later-local' });
      model.destroy('row-1');
    });
    const baseline = {
  
      affectedTicks: affectedReader.renders(),
      unrelatedTicks: unrelatedReader.renders()
    };
    await act(async () => {
      deferred!.resolve({ insertRow: { row: { id: 'row-1', value: 'slow-remote' } } });
      await pending;
    });

    expect(model.find('row-1')).toBeUndefined();

    expect(affectedReader.renders() - baseline.affectedTicks).toBe(0);
    expect(unrelatedReader.renders() - baseline.unrelatedTicks).toBe(0);
    expect(unrelated.find('unrelated-1')).toEqual({ id: 'unrelated-1', value: 'unchanged' });
    affectedReader.unmount();
    unrelatedReader.unmount();
  });
});
