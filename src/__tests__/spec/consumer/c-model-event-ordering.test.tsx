import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { acquireModelSubscriptions, advanceRuntimeGeneration, getCommitBus, registerModelEvent, getApplyRuntime } from '../../testApi';
import type { ModelEventRegistration, WritePlan } from '../../testApi';
import {
  configureDb,
  defineModel,
  defineShape,
  f,
  resetRuntime,
  type DbTransport,
  type StoragePlane,
  useDbSubscriptions
} from '../../../index';

type MessageRow = { id: string; label: string };
type LivePayload = { message: MessageRow; sequence: number };
type LiveData = { messageChanged: LivePayload };
type LiveVariables = { roomId: string };
const makeDocument = (): TypedDocumentNode<LiveData, LiveVariables> =>
  ({
    kind: 'Document',
    definitions: [
      {
        kind: 'OperationDefinition',
        operation: 'subscription',
        selectionSet: {
          kind: 'SelectionSet',
          selections: [
            {
              kind: 'Field',
              alias: { kind: 'Name', value: 'payloadAlias' },
              name: { kind: 'Name', value: 'messageChanged' }
            }
          ]
        }
      }
    ]
  }) as unknown as TypedDocumentNode<LiveData, LiveVariables>;

const createMemoryPlane = (): StoragePlane => {
  const values = new Map<string, string>();
  return {
    get: key => values.get(key),
    set: (key, value) => {
      if (value === null) values.delete(key);
      else values.set(key, value);
    },
    keys: prefix => [...values.keys()].filter(key => key.startsWith(prefix))
  };
};

type Subscriber = {
  options: { query: unknown; variables?: Record<string, unknown> };
  handlers: { next: (data: unknown) => void; error: (error: unknown) => void };
  unsubscribe: jest.Mock;
};

const createTransport = (onSubscribe?: (handlers: Subscriber['handlers'], options: Subscriber['options']) => void) => {
  const subscribers: Subscriber[] = [];
  const transport: DbTransport = {
    async query<TData>(_operation: unknown): Promise<{ data: TData }> {
      return { data: {} as TData };
    },
    async mutation<TData>(_operation: unknown): Promise<{ data: TData }> {
      return { data: {} as TData };
    },
    subscribe(options, handlers) {
      const unsubscribe = jest.fn();
      const subscriber = { options, handlers, unsubscribe };
      subscribers.push(subscriber);
      onSubscribe?.(handlers, options);
      return unsubscribe;
    }
  };
  return { transport, subscribers };
};

const MessageSchema = defineShape<MessageRow>()({ label: f.str() });
type RegistryRegistration = ModelEventRegistration<LivePayload, MessageRow, MessageRow>;
type RegistryRoot = RegistryRegistration['root'];
type RegistryRootSelect = (context: { payload: LivePayload }) => MessageRow | null;
type RegistryWrite = (context: { payload: LivePayload }, plan: WritePlan) => void;
const defaultRootSelect: RegistryRootSelect = ({ payload: eventPayload }) => eventPayload.message;

const createModel = (
  key: string,
  document: TypedDocumentNode<LiveData, LiveVariables>,
  variables: LiveVariables,
  root: RegistryRoot = { insert: { select: defaultRootSelect } },
  write?: RegistryWrite
) =>
  defineModel(key, {
    schema: MessageSchema,
    events: owner => ({
      changed: owner.gql.live(document, { variables, root, write })
    })
  });

const payload = (id: string, sequence: number): LivePayload => ({ message: { id, label: `message-${id}` }, sequence });
const mountedRoots = new Set<TestRenderer.ReactTestRenderer>();

const renderActivation = (active: boolean): TestRenderer.ReactTestRenderer => {
  let root!: TestRenderer.ReactTestRenderer;
  act(() => {
    root = TestRenderer.create(React.createElement(Activation, { active }));
  });
  mountedRoots.add(root);
  return root;
};

function Activation({ active }: { active: boolean }): null {
  useDbSubscriptions(active);
  return null;
}

const subscriberFor = (subscribers: Subscriber[], variables: LiveVariables): Subscriber => {
  const matches = subscribers.filter(subscriber => subscriber.options.variables === variables);
  expect(matches).toHaveLength(1);
  return matches[0]!;
};

afterEach(() => {
  act(() => {
    for (const root of mountedRoots) root.unmount();
  });
  mountedRoots.clear();
  resetRuntime();
});

describe('model event ordering', () => {
  it('[I20] [W28] delivers after the model write and exposes committed state to the listener', () => {
    const document = makeDocument();
    const variables = { roomId: 'ordering-post-commit' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const model = createModel('OrderingPostCommit', document, variables);
    const seen: string[] = [];
    const unsubscribe = model.events.changed.subscribe(event => {
      seen.push(model.find(event.message.id)?.label ?? 'missing');
    });

    renderActivation(true);
    act(() => subscriberFor(subscribers, variables).handlers.next({ payloadAlias: payload('post-commit', 1) }));

    expect(seen).toEqual(['message-post-commit']);
    expect(model.find('post-commit')).toEqual(payload('post-commit', 1).message);
    unsubscribe();
  });

  it('[T8] [W22] delivers an invalidation-only event after authoritative invalidation', () => {
    const document = makeDocument();
    const variables = { roomId: 'ordering-invalidation' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const order: string[] = [];
    const invalidationTarget = { invalidate: () => order.push('invalidation') };
    const model = createModel(
      'OrderingInvalidation',
      document,
      variables,
      { insert: { select: () => null } },
      (_context, plan) => plan.invalidate(invalidationTarget)
    );
    const unsubscribe = model.events.changed.subscribe(() => order.push('listener'));

    renderActivation(true);
    act(() => subscriberFor(subscribers, variables).handlers.next({ payloadAlias: payload('invalidation', 1) }));

    expect(order).toEqual(['invalidation', 'listener']);
    unsubscribe();
  });

  it('delivers a valid plan but drops both write and delivery after a planning failure', () => {
    const document = makeDocument();
    const variables = { roomId: 'ordering-planning-failure' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const target = defineModel('OrderingPlanningTarget', { schema: MessageSchema });
    const model = createModel(
      'OrderingPlanningFailure',
      document,
      variables,
      { insert: { select: defaultRootSelect } },
      (context, plan) => {
        if (context.payload.message.id !== 'planning-failure') return;
        plan.update(target, 'missing', { label: undefined as unknown as string });
      }
    );
    const seen: LivePayload[] = [];
    const unsubscribe = model.events.changed.subscribe(payloadValue => seen.push(payloadValue));

    renderActivation(true);
    const subscriber = subscriberFor(subscribers, variables);
    const validPayload = payload('planning-valid', 1);
    act(() => subscriber.handlers.next({ payloadAlias: validPayload }));
    expect(seen).toEqual([validPayload]);
    expect(model.find('planning-valid')).toEqual(validPayload.message);

    act(() => subscriber.handlers.next({ payloadAlias: payload('planning-failure', 2) }));
    expect(seen).toEqual([validPayload]);
    expect(model.find('planning-failure')).toBeUndefined();
    expect(target.find('missing')).toBeUndefined();
    unsubscribe();
  });

  it('does not publish a presentation event for missing write-plan targets', () => {
    const document = makeDocument();
    const variables = { roomId: 'ordering-missing-target' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const target = defineModel('OrderingMissingTarget', { schema: MessageSchema });
    const model = createModel(
      'OrderingMissingTargetEvent',
      document,
      variables,
      { insert: { select: () => null } },
      (_context, plan) => {
        plan.update(target, 'missing', { label: 'late patch' });
        plan.destroy(target, 'missing');
      }
    );
    const listener = jest.fn();
    const unsubscribe = model.events.changed.subscribe(listener);

    renderActivation(true);
    act(() => subscriberFor(subscribers, variables).handlers.next({ payloadAlias: payload('missing-target', 1) }));

    expect(target.find('missing')).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('delivers a commit whose delta write is refused and keeps memory consistent', () => {
    const document = makeDocument();
    const variables = { roomId: 'ordering-commit-failure' };
    const storage = createMemoryPlane();
    const failure = new Error('commit storage failure');
    let failOnce = true;
    const failingStorage: StoragePlane = {
      get: storage.get,
      keys: storage.keys,
      set: (key, value) => {
        if (failOnce) {
          failOnce = false;
          throw failure;
        }
        storage.set(key, value);
      }
    };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: failingStorage, transport });
    const model = createModel('OrderingCommitFailure', document, variables);
    const listener = jest.fn();
    const unsubscribe = model.events.changed.subscribe(listener);

    renderActivation(true);
    act(() => subscriberFor(subscribers, variables).handlers.next({ payloadAlias: payload('commit-failure', 1) }));

    // The refused write was the commit's delta key: the refusal is contained, memory stays
    // consistent, the event delivers, and the flush lands the covering snapshot.
    expect(listener).toHaveBeenCalledTimes(1);
    expect(model.find('commit-failure')).toMatchObject({ label: 'message-commit-failure' });
    getApplyRuntime().flushCacheSnapshots();
    expect(storage.keys('dbl:row:').length).toBeGreaterThan(0);
    unsubscribe();
  });

  it('contains envelope planning failures before commit and presentation delivery', () => {
    const document = makeDocument();
    const variables = { roomId: 'ordering-envelope-failure' };
    const onSyncError = jest.fn();
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport, defaults: { onSyncError } });
    const registration = registerModelEvent<LivePayload>({
      modelKey: 'OrderingEnvelopeFailure',
      eventName: 'changed',
      document,
      variables,
      owner: {
        modelId: 'OrderingEnvelopeFailure',
        planRows: () => [{ kind: 'upsert', model: 'MissingEnvelopeTarget', rows: [{ id: 'missing', label: 'missing' }] }]
      },
      root: { insert: { select: defaultRootSelect } }
    });
    const listener = jest.fn();
    const unsubscribe = registration.subscribe(listener);
    const release = acquireModelSubscriptions();

    act(() => subscriberFor(subscribers, variables).handlers.next({ payloadAlias: payload('envelope-failure', 1) }));

    expect(listener).not.toHaveBeenCalled();
    expect(onSyncError).toHaveBeenCalledWith(expect.any(Error), {
      source: 'model-event',
      model: 'OrderingEnvelopeFailure',
      event: 'changed'
    });
    release();
    unsubscribe();
  });

  it('does not deliver presentation after commit changes the runtime generation', () => {
    const document = makeDocument();
    const variables = { roomId: 'ordering-post-commit-reset' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const model = createModel('OrderingPostCommitReset', document, variables);
    const listener = jest.fn();
    const unsubscribe = model.events.changed.subscribe(listener);
    const unsubscribeCommits = getCommitBus().subscribeAll(() => advanceRuntimeGeneration());

    renderActivation(true);
    act(() => subscriberFor(subscribers, variables).handlers.next({ payloadAlias: payload('post-commit-reset', 1) }));

    expect(model.find('post-commit-reset')).toEqual(payload('post-commit-reset', 1).message);
    expect(listener).not.toHaveBeenCalled();
    unsubscribeCommits();
    unsubscribe();
  });

  it('reports invalidation failures and stops delivery when invalidation resets runtime', () => {
    const document = makeDocument();
    const failureVariables = { roomId: 'ordering-invalidation-failure' };
    const resetVariables = { roomId: 'ordering-invalidation-reset' };
    const onSyncError = jest.fn();
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport, defaults: { onSyncError } });
    const failureModel = createModel(
      'OrderingInvalidationFailure',
      document,
      failureVariables,
      { insert: { select: () => null } },
      (_context, plan) => plan.invalidate({ invalidate: () => { throw new Error('invalidation failed'); } })
    );
    const resetModel = createModel(
      'OrderingInvalidationReset',
      document,
      resetVariables,
      { insert: { select: () => null } },
      (_context, plan) => plan.invalidate({ invalidate: () => advanceRuntimeGeneration() })
    );
    const failureListener = jest.fn();
    const resetListener = jest.fn();
    const unsubscribeFailure = failureModel.events.changed.subscribe(failureListener);
    const unsubscribeReset = resetModel.events.changed.subscribe(resetListener);

    renderActivation(true);
    act(() => subscriberFor(subscribers, failureVariables).handlers.next({ payloadAlias: payload('invalidation-failure', 1) }));
    act(() => subscriberFor(subscribers, resetVariables).handlers.next({ payloadAlias: payload('invalidation-reset', 2) }));

    expect(failureListener).toHaveBeenCalledTimes(1);
    expect(resetListener).not.toHaveBeenCalled();
    expect(onSyncError).toHaveBeenCalledWith(expect.any(Error), {
      source: 'model-event',
      model: 'OrderingInvalidationFailure',
      event: 'changed'
    });
    unsubscribeFailure();
    unsubscribeReset();
  });

  it('does not deliver after the event generation becomes stale', () => {
    const document = makeDocument();
    const variables = { roomId: 'ordering-stale-generation' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const model = createModel('OrderingStaleGeneration', document, variables, {
      insert: {
        select: () => {
          advanceRuntimeGeneration();
          return payload('stale-generation', 1).message;
        }
      }
    });
    const listener = jest.fn();
    const unsubscribe = model.events.changed.subscribe(listener);

    renderActivation(true);
    act(() => subscriberFor(subscribers, variables).handlers.next({ payloadAlias: payload('stale-generation', 1) }));

    expect(listener).not.toHaveBeenCalled();
    expect(model.find('stale-generation')).toBeUndefined();
    unsubscribe();
  });

  it('removes only the returned presentation listener teardown while the sibling keeps receiving values', () => {
    const document = makeDocument();
    const variables = { roomId: 'ordering-teardown' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const model = createModel('OrderingTeardown', document, variables);
    const firstSeen: LivePayload[] = [];
    const secondSeen: LivePayload[] = [];
    const unsubscribeFirst = model.events.changed.subscribe(payloadValue => firstSeen.push(payloadValue));
    const unsubscribeSecond = model.events.changed.subscribe(payloadValue => secondSeen.push(payloadValue));

    renderActivation(true);
    const subscriber = subscriberFor(subscribers, variables);
    const firstPayload = payload('teardown-first', 1);
    const secondPayload = payload('teardown-second', 2);
    act(() => subscriber.handlers.next({ payloadAlias: firstPayload }));
    unsubscribeFirst();
    act(() => subscriber.handlers.next({ payloadAlias: secondPayload }));

    expect(firstSeen).toEqual([firstPayload]);
    expect(secondSeen).toEqual([firstPayload, secondPayload]);
    expect(model.find('teardown-second')).toEqual(secondPayload.message);
    unsubscribeSecond();
  });

  it('keeps listeners across reset while fencing stale callbacks', () => {
    const document = makeDocument();
    const variables = { roomId: 'ordering-reset' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const model = createModel('OrderingReset', document, variables);
    const listener = jest.fn();
    const unsubscribe = model.events.changed.subscribe(listener);

    renderActivation(true);
    const oldSubscriber = subscriberFor(subscribers, variables);
    act(() => resetRuntime());
    const currentSubscribers = subscribers.filter(subscriber => subscriber.options.variables === variables);

    act(() => oldSubscriber.handlers.next({ payloadAlias: payload('reset-stale', 1) }));
    act(() => currentSubscribers[1]!.handlers.next({ payloadAlias: payload('reset-current', 2) }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(payload('reset-current', 2));
    expect(model.find('reset-stale')).toBeUndefined();
    expect(model.find('reset-current')).toEqual(payload('reset-current', 2).message);
    unsubscribe();
  });

  it('[ID14] [OP21] keeps one row and one listener across response-before-subscription and subscription-before-response', () => {
    const document = makeDocument();
    const beforeVariables = { roomId: 'ordering-before-subscription' };
    const beforeResponse = payload('before-subscription', 1);
    const synchronous = createTransport((handlers, options) => {
      if (options.variables === beforeVariables) handlers.next({ payloadAlias: beforeResponse });
    });
    configureDb({ storage: createMemoryPlane(), transport: synchronous.transport });
    const beforeModel = createModel('OrderingBeforeSubscription', document, beforeVariables);
    const beforeListener = jest.fn();
    const unsubscribeBefore = beforeModel.events.changed.subscribe(beforeListener);
    renderActivation(true);

    expect(beforeModel.find(beforeResponse.message.id)).toEqual(beforeResponse.message);
    expect(beforeListener).toHaveBeenCalledTimes(1);

    const afterVariables = { roomId: 'ordering-after-subscription' };
    const afterResponse = payload('after-subscription', 2);
    const afterModel = createModel('OrderingAfterSubscription', document, afterVariables);
    const afterListener = jest.fn();
    const unsubscribeAfter = afterModel.events.changed.subscribe(afterListener);
    const afterSubscriber = subscriberFor(synchronous.subscribers, afterVariables);
    act(() => afterSubscriber.handlers.next({ payloadAlias: afterResponse }));

    expect(afterModel.find(afterResponse.message.id)).toEqual(afterResponse.message);
    expect(afterListener).toHaveBeenCalledTimes(1);
    unsubscribeBefore();
    unsubscribeAfter();
  });

  it('[W23] [S8] keeps the presentation listener isolated from write surfaces', () => {
    const document = makeDocument();
    const variables = { roomId: 'ordering-listener-isolation' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const model = createModel('OrderingListenerIsolation', document, variables);
    const listener = jest.fn((event: LivePayload) => {
      expect(Object.keys(event).sort()).toEqual(['message', 'sequence']);
      expect('write' in event).toBe(false);
      expect('model' in event).toBe(false);
    });
    const unsubscribe = model.events.changed.subscribe(listener);

    renderActivation(true);
    act(() => subscriberFor(subscribers, variables).handlers.next({ payloadAlias: payload('isolated', 1) }));

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
