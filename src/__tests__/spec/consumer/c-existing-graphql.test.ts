import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import * as dbLayer from '../../../index';
import { acquireModelSubscriptions } from '../../testApi';

type Row = { id: string; label: string };
type RelationData = { rows: Row[] };
type RelationVariables = { bucket: string };
type ActionInput = { label: string };
type ActionVariables = { input: ActionInput };
type ActionPayload = { row: Row; clientMutationId?: string | null };
type ActionData = { createRow: ActionPayload };
type LivePayload = { row: Row };
type LiveData = { rowChanged: LivePayload };
type LiveVariables = { channel: string };
type RecordedOperation = Record<string, unknown> & { variables?: unknown };

const makeDocument = <TData, TVariables>(
  operation: 'query' | 'mutation' | 'subscription',
  rootField: string
): TypedDocumentNode<TData, TVariables> =>
  ({
    kind: 'Document',
    definitions: [
      {
        kind: 'OperationDefinition',
        operation,
        selectionSet: {
          kind: 'SelectionSet',
          selections: [{ kind: 'Field', name: { kind: 'Name', value: rootField } }]
        }
      }
    ]
  }) as unknown as TypedDocumentNode<TData, TVariables>;

const createMemoryPlane = (): dbLayer.StoragePlane => {
  const values = new Map<string, string>();
  return {
    get: key => values.get(key),
    set: entries => {
      for (const entry of entries) {
        if (entry.value === null) values.delete(entry.key);
        else values.set(entry.key, entry.value);
      }
    },
    keys: prefix => [...values.keys()].filter(key => key.startsWith(prefix))
  };
};

const createFakeTransport = (responses: { query?: unknown[]; mutation?: unknown[] } = {}) => {
  const queryResponses = [...(responses.query ?? [])];
  const mutationResponses = [...(responses.mutation ?? [])];
  const queryCalls: RecordedOperation[] = [];
  const mutationCalls: RecordedOperation[] = [];
  const subscriptionCalls: Array<{
    options: RecordedOperation;
    handlers: { next: (data: unknown) => void; error: (error: unknown) => void };
    unsubscribe: ReturnType<typeof jest.fn>;
  }> = [];
  const transport: dbLayer.DbTransport = {
    async query<TData>(operation: unknown) {
      queryCalls.push(operation as RecordedOperation);
      const data = queryResponses.shift();
      if (data === undefined) throw new Error('Missing fake query response');
      return { data: data as TData };
    },
    async mutation<TData>(operation: unknown) {
      mutationCalls.push(operation as RecordedOperation);
      const data = mutationResponses.shift();
      if (data === undefined) throw new Error('Missing fake mutation response');
      return { data: data as TData };
    },
    subscribe(options, handlers) {
      const unsubscribe = jest.fn();
      subscriptionCalls.push({ options: options as RecordedOperation, handlers, unsubscribe });
      return unsubscribe;
    }
  };
  return { transport, queryCalls, mutationCalls, subscriptionCalls };
};

const RowSchema = dbLayer.defineShape<Row>()({ label: dbLayer.f.str() });
const liveVariables: LiveVariables = { channel: 'existing-graphql' };
type DocumentDeclaration<TDocument> = { document: TDocument };

const createModelFixture = (key: string, captureTempId: (tempId: string) => void = () => {}) => {
  const relationDocument = makeDocument<RelationData, RelationVariables>('query', 'rows');
  const actionDocument = makeDocument<ActionData, ActionVariables>('mutation', 'createRow');
  const liveDocument = makeDocument<LiveData, LiveVariables>('subscription', 'rowChanged');
  const declarations: {
    relation?: DocumentDeclaration<typeof relationDocument>;
    action?: DocumentDeclaration<typeof actionDocument>;
    live?: DocumentDeclaration<typeof liveDocument>;
  } = {};
  const model = dbLayer.defineModel(key, {
    schema: RowSchema,
    relations: owner => ({
      rows: {
        sort: 'server-order',
        remote: (declarations.relation = owner.gql.list(relationDocument, {
          variables: (params: RelationVariables) => ({ bucket: params.bucket }),
          select: data => data.rows
        }))
      }
    }),
    actions: owner => ({
      create: (declarations.action = owner.gql.action(actionDocument, {
        mode: 'request',
        result: 'createRow',
        variables: (input: ActionInput) => ({ input }),
        root: { insert: { select: ({ data }) => data.createRow.row } },
        optimistic: {
          root: {
            insert: {
              select: ({ input, tempId }) => {
                captureTempId(tempId);
                return { id: tempId, label: input.label };
              }
            }
          }
        }
      }))
    }),
    events: owner => ({
      changed: (declarations.live = owner.gql.live(liveDocument, {
        variables: liveVariables,
        root: { insert: { select: context => context.payload.row } }
      }))
    }),
    maintenance: { dropTempRowsAfterMs: 60_000 }
  });
  return {
    model,
    relationDocument,
    actionDocument,
    liveDocument,
    relationDeclaration: declarations.relation!,
    actionDeclaration: declarations.action!,
    liveDeclaration: declarations.live!
  };
};

const cleanupRegistry = new Set<() => void>();

afterEach(() => {
  for (const cleanup of cleanupRegistry) cleanup();
  cleanupRegistry.clear();
  dbLayer.resetRuntime();
});

describe('existing GraphQL boundary', () => {
  it('[ID13] action replaces its temp row from an ordinary server row without echo identity', async () => {
    const serverRow = { id: 'server-id13', label: 'server' };
    const fake = createFakeTransport({ mutation: [{ createRow: { row: serverRow } }] });
    dbLayer.configureDb({ storage: createMemoryPlane(), transport: fake.transport });
    let tempId = '';
    const { model } = createModelFixture('SpecExistingGraphqlId13', value => {
      tempId = value;
    });

    await model.actions.create.run({ label: 'optimistic' });

    const rows = model.where({}).read();
    expect(rows).toEqual([serverRow]);
    expect(model.find(tempId)).toBeUndefined();
    expect(rows[0]).not.toHaveProperty('clientId');
    expect(rows[0]).not.toHaveProperty('clientMutationId');
  });

  it('[OP18] model-producing relation action and live documents stay owned by their model declarations', () => {
    const fake = createFakeTransport();
    dbLayer.configureDb({ storage: createMemoryPlane(), transport: fake.transport });
    const fixture = createModelFixture('SpecExistingGraphqlOwnership');

    expect(fake.queryCalls).toEqual([]);
    expect(fake.mutationCalls).toEqual([]);
    expect(fake.subscriptionCalls).toEqual([]);
    expect(fixture.relationDeclaration.document).toBe(fixture.relationDocument);
    expect(fixture.actionDeclaration.document).toBe(fixture.actionDocument);
    expect(fixture.liveDeclaration.document).toBe(fixture.liveDocument);
    expect({
      relationFetch: 'fetch' in fixture.relationDeclaration,
      actionRun: 'run' in fixture.actionDeclaration,
      liveSubscribe: 'subscribe' in fixture.liveDeclaration
    }).toEqual({ relationFetch: false, actionRun: false, liveSubscribe: false });
    expect(typeof fixture.model.rows({ bucket: 'owned' }).fetch).toBe('function');
    expect(typeof fixture.model.actions.create.run).toBe('function');
    expect(typeof fixture.model.events.changed.subscribe).toBe('function');
  });

  it('[OP19] model-less GraphQL has no DBLayer terminal', () => {
    expect({
      defineCommand: 'defineCommand' in dbLayer,
      defineFetch: 'defineFetch' in dbLayer
    }).toEqual({ defineCommand: false, defineFetch: false });
  });

  it('[S12] relation action and live transport receive the original document and exact generated variables', async () => {
    const relationVariables: RelationVariables = { bucket: 'boundary' };
    const actionInput: ActionInput = { label: 'action-input' };
    const fake = createFakeTransport({
      query: [{ rows: [{ id: 'relation-s12', label: 'relation' }] }],
      mutation: [{ createRow: { row: { id: 'action-s12', label: 'action' } } }]
    });
    dbLayer.configureDb({ storage: createMemoryPlane(), transport: fake.transport });
    const fixture = createModelFixture('SpecExistingGraphqlS12');

    await fixture.model.rows(relationVariables).fetch();
    await fixture.model.actions.create.run(actionInput);
    cleanupRegistry.add(acquireModelSubscriptions());

    const queryCalls = fake.queryCalls.filter(call => call.query === fixture.relationDocument);
    const mutationCalls = fake.mutationCalls.filter(call => call.mutation === fixture.actionDocument);
    const subscriptions = fake.subscriptionCalls.filter(call => call.options.query === fixture.liveDocument);
    expect(queryCalls).toHaveLength(1);
    expect(mutationCalls).toHaveLength(1);
    expect(subscriptions).toHaveLength(1);
    expect(queryCalls[0]!.query).toBe(fixture.relationDocument);
    expect(queryCalls[0]!.variables).toEqual(relationVariables);
    expect(queryCalls[0]).toEqual({ query: fixture.relationDocument, variables: relationVariables });
    expect(mutationCalls[0]!.mutation).toBe(fixture.actionDocument);
    expect(mutationCalls[0]!.variables).toEqual({ input: actionInput });
    expect(mutationCalls[0]).toEqual({ mutation: fixture.actionDocument, variables: { input: actionInput } });
    expect(subscriptions[0]!.options.query).toBe(fixture.liveDocument);
    expect(subscriptions[0]!.options.variables).toEqual(liveVariables);
    expect(subscriptions[0]!.options).toEqual({ query: fixture.liveDocument, variables: liveVariables });
  });

  it('[T12] clientMutationId presence or absence is opaque to row identity and result landing', async () => {
    const serverRow = { id: 'relay-server', label: 'server' };
    const fake = createFakeTransport({
      mutation: [
        { createRow: { row: serverRow } },
        { createRow: { row: serverRow, clientMutationId: 'opaque-relay-value' } }
      ]
    });
    dbLayer.configureDb({ storage: createMemoryPlane(), transport: fake.transport });
    let withoutRelayTempId = '';
    let withRelayTempId = '';
    const withoutRelay = createModelFixture('SpecExistingGraphqlRelayWithout', value => {
      withoutRelayTempId = value;
    });
    const withRelay = createModelFixture('SpecExistingGraphqlRelayWith', value => {
      withRelayTempId = value;
    });

    await withoutRelay.model.actions.create.run({ label: 'optimistic' });
    await withRelay.model.actions.create.run({ label: 'optimistic' });

    const withoutRelayState = withoutRelay.model.where({}).read();
    const withRelayState = withRelay.model.where({}).read();
    expect(withoutRelayState).toEqual(withRelayState);
    expect(withoutRelayState).toEqual([serverRow]);
    expect(withoutRelay.model.find(withoutRelayTempId)).toBeUndefined();
    expect(withRelay.model.find(withRelayTempId)).toBeUndefined();
    expect(withRelayState[0]).not.toHaveProperty('clientMutationId');
  });
});
