import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import {
  acquireModelSubscriptions,
  advanceRuntimeGeneration,
  registerModelEvent,
  restartModelEventRegistry,
  setDbTransport
} from '../../testApi';
import type { ModelEventRegistration } from '../../testApi';
import { diagnostics } from '../helpers/harness';
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

const makeDocumentVariant = (
  operation: 'query' | 'subscription',
  fields: ReadonlyArray<{ field: string; alias: string }>
): TypedDocumentNode<LiveData, LiveVariables> =>
  ({
    kind: 'Document',
    definitions: [
      {
        kind: 'OperationDefinition',
        operation,
        selectionSet: {
          kind: 'SelectionSet',
          selections: fields.map(({ field, alias }) => ({
            kind: 'Field',
            alias: { kind: 'Name', value: alias },
            name: { kind: 'Name', value: field }
          }))
        }
      }
    ]
  }) as unknown as TypedDocumentNode<LiveData, LiveVariables>;

const makeDocument = (field = 'messageChanged', alias = 'payloadAlias'): TypedDocumentNode<LiveData, LiveVariables> =>
  makeDocumentVariant('subscription', [{ field, alias }]);

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

const defaultRootSelect: RegistryRootSelect = ({ payload: eventPayload }) => eventPayload.message;

const createModel = (
  key: string,
  document: TypedDocumentNode<LiveData, LiveVariables>,
  variables: LiveVariables,
  debounce?: { ms: number },
  root: RegistryRoot = { insert: { select: defaultRootSelect } }
) =>
  defineModel(key, {
    schema: MessageSchema,
    events: owner => ({
      changed: owner.gql.live(document, {
        variables,
        debounce,
        root
      })
    })
  });

const createRegistryRegistration = (
  modelKey: string,
  document: TypedDocumentNode<LiveData, LiveVariables>,
  variables: LiveVariables,
  root: RegistryRoot = { insert: { select: defaultRootSelect } }
): RegistryRegistration => ({
  modelKey,
  eventName: 'changed',
  document,
  variables,
  owner: { modelId: modelKey, planRows: () => [] },
  root,
  write: (_context, plan) => {
    plan.invalidate({ invalidate: () => undefined });
  }
});

const payload = (id: string, sequence: number): LivePayload => ({ message: { id, label: `message-${id}` }, sequence });
const mountedRoots = new Set<TestRenderer.ReactTestRenderer>();
const cleanupRegistry = new Set<() => void>();

const registerCleanup = (cleanup: () => void): (() => void) => {
  let active = true;
  const registeredCleanup = (): void => {
    if (!active) return;
    active = false;
    cleanupRegistry.delete(registeredCleanup);
    cleanup();
  };
  cleanupRegistry.add(registeredCleanup);
  return registeredCleanup;
};

const subscriberFor = (subscribers: Subscriber[], variables: LiveVariables): Subscriber => {
  const matches = subscribers.filter(subscriber => subscriber.options.variables === variables);
  expect(matches).toHaveLength(1);
  return matches[0]!;
};

const renderActivation = (active: boolean) => {
  const root = TestRenderer.create(React.createElement(Activation, { active }));
  mountedRoots.add(root);
  return root;
};

function Activation({ active }: { active: boolean }): null {
  useDbSubscriptions(active);
  return null;
}

afterEach(() => {
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [...cleanupRegistry]) {
    try {
      cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  cleanupRegistry.clear();
  try {
    act(() => {
      for (const root of mountedRoots) root.unmount();
    });
  } catch (error) {
    cleanupErrors.push(error);
  }
  mountedRoots.clear();
  jest.useRealTimers();
  try {
    resetRuntime();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'model live registry cleanup failed');
});

describe('model live subscription registry', () => {
  it('keeps inactive mounts transport-free and activates only after active becomes true', () => {
    const document = makeDocument();
    const variables = { roomId: 'room-1' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    createModel('RegistryInactive', document, variables);

    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = renderActivation(false);
    });
    expect(subscribers).toHaveLength(0);

    act(() => {
      root.update(React.createElement(Activation, { active: true }));
    });
    expect(subscribers).toHaveLength(1);

    act(() => {
      root.update(React.createElement(Activation, { active: false }));
    });
    expect(subscribers[0]!.unsubscribe).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('shares one transport subscription across duplicate active mounts and tears down on the last unmount', () => {
    const document = makeDocument();
    const variables = { roomId: 'room-2' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    createModel('RegistryDuplicate', document, variables);

    let first!: TestRenderer.ReactTestRenderer;
    let second!: TestRenderer.ReactTestRenderer;
    act(() => {
      first = renderActivation(true);
      second = renderActivation(true);
    });

    const subscriber = subscriberFor(subscribers, variables);
    act(() => first.unmount());
    expect(subscriber.unsubscribe).not.toHaveBeenCalled();
    act(() => second.unmount());
    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('makes owner and presentation teardown idempotent', () => {
    const document = makeDocument();
    const variables = { roomId: 'room-idempotent-teardown' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const registration = registerModelEvent(createRegistryRegistration('RegistryIdempotentTeardown', document, variables));
    const unsubscribe = registration.subscribe(jest.fn());
    const release = acquireModelSubscriptions();
    const subscriber = subscriberFor(subscribers, variables);

    unsubscribe();
    unsubscribe();
    release();
    release();

    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('rejects a same-generation duplicate declaration before changing the slot', () => {
    const document = makeDocument();
    const variables = { roomId: 'room-10' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const first = registerModelEvent(createRegistryRegistration('RegistrySameGeneration', document, variables));
    const listener = jest.fn();
    const unsubscribe = registerCleanup(first.subscribe(listener));
    const release = registerCleanup(acquireModelSubscriptions());
    const subscriber = subscriberFor(subscribers, variables);

    expect(() =>
      registerModelEvent(createRegistryRegistration('RegistrySameGeneration', document, variables))
    ).toThrow('Model event already registered for RegistrySameGeneration.changed');
    expect(subscriber.unsubscribe).not.toHaveBeenCalled();

    const replacementVariables = { roomId: 'room-10-replacement' };
    advanceRuntimeGeneration();
    registerModelEvent(createRegistryRegistration('RegistrySameGeneration', document, replacementVariables));

    const replacementSubscriber = subscriberFor(subscribers, replacementVariables);
    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
    const replacementPayload = payload('same-generation-replacement', 2);
    act(() => replacementSubscriber.handlers.next({ payloadAlias: replacementPayload }));
    expect(listener).toHaveBeenCalledWith(replacementPayload);

    release();
    unsubscribe();
  });

  it('activates a declaration registered after the active hook mount', () => {
    const document = makeDocument();
    const variables = { roomId: 'room-11' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = renderActivation(true);
    });
    const beforeDeclaration = subscribers.length;

    createModel('RegistryAfterActivation', document, variables);

    expect(subscribers.length).toBe(beforeDeclaration + 1);
    subscriberFor(subscribers, variables);
    act(() => root.unmount());
  });

  it('passes the exact document and variables references to transport and maps an aliased root field', () => {
    const document = makeDocument('messageChanged', 'messageAlias');
    const variables = { roomId: 'room-3' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const model = createModel('RegistryExact', document, variables);
    const seen: LivePayload[] = [];
    const unsubscribe = registerCleanup(
      model.events.changed.subscribe(payloadValue => {
        expect(model.find(payloadValue.message.id)).toEqual(payloadValue.message);
        seen.push(payloadValue);
      })
    );

    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = renderActivation(true);
    });

    const subscriber = subscriberFor(subscribers, variables);
    expect(subscriber.options.query).toBe(document);
    expect(subscriber.options.variables).toBe(variables);
    expect(Object.getPrototypeOf(model.events)).toBeNull();
    expect('entries' in model.events).toBe(false);
    expect('apply' in model.events).toBe(false);

    act(() => subscriber.handlers.next({ messageAlias: payload('exact', 1) }));
    expect(model.find('exact')).toEqual(payload('exact', 1).message);
    expect(seen).toEqual([payload('exact', 1)]);

    unsubscribe();
    act(() => root.unmount());
  });

  it('stops all later presentation delivery after the returned unsubscribe runs', () => {
    const document = makeDocument();
    const variables = { roomId: 'room-3-unsubscribe' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const registration = registerModelEvent(createRegistryRegistration('RegistryPresentationUnsubscribe', document, variables));
    const listener = jest.fn();
    const unsubscribe = registerCleanup(registration.subscribe(listener));
    const release = registerCleanup(acquireModelSubscriptions());
    const subscriber = subscriberFor(subscribers, variables);
    const firstPayload = payload('presentation-first', 1);
    const secondPayload = payload('presentation-second', 2);

    act(() => subscriber.handlers.next({ payloadAlias: firstPayload }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(firstPayload);

    unsubscribe();
    act(() => subscriber.handlers.next({ payloadAlias: secondPayload }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalledWith(secondPayload);
    release();
  });

  it('does not notify presentation listeners for null or zero-work declarations', () => {
    const document = makeDocument();
    const nullVariables = { roomId: 'room-12-null' };
    const zeroWorkVariables = { roomId: 'room-12-zero' };
    const { transport, subscribers } = createTransport();
    const storage = createMemoryPlane();
    configureDb({ storage, transport });
    const nullModel = createModel('RegistryNullDelivery', document, nullVariables, undefined, { insert: { select: () => null } });
    const zeroWorkModel = createModel('RegistryZeroWork', document, zeroWorkVariables, undefined, { destroy: { select: () => 'missing' } });
    const nullListener = jest.fn();
    const zeroWorkListener = jest.fn();
    const unsubscribeNull = registerCleanup(nullModel.events.changed.subscribe(nullListener));
    const unsubscribeZeroWork = registerCleanup(zeroWorkModel.events.changed.subscribe(zeroWorkListener));

    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = renderActivation(true);
    });
    const nullSubscriber = subscriberFor(subscribers, nullVariables);
    const zeroWorkSubscriber = subscriberFor(subscribers, zeroWorkVariables);
    const beforeCommits = diagnostics().snapshot().commits;

    act(() => {
      nullSubscriber.handlers.next({ payloadAlias: payload('null-delivery', 1) });
      zeroWorkSubscriber.handlers.next({ payloadAlias: payload('zero-work', 1) });
    });

    expect(nullListener).not.toHaveBeenCalled();
    expect(zeroWorkListener).not.toHaveBeenCalled();
    expect(diagnostics().snapshot().commits - beforeCommits).toBe(0);
    expect(diagnostics().snapshot().commits - beforeCommits).toBe(0);
    act(() => root.unmount());
    unsubscribeNull();
    unsubscribeZeroWork();
  });

  it('rejects non-subscription and multi-root-field documents at declaration time', () => {
    const { transport } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const nonSubscriptionDocument = makeDocumentVariant('query', [{ field: 'messageChanged', alias: 'payloadAlias' }]);
    const multiFieldDocument = makeDocumentVariant('subscription', [
      { field: 'messageChanged', alias: 'payloadAlias' },
      { field: 'otherChanged', alias: 'otherAlias' }
    ]);

    expect(() => createModel('RegistryInvalidQuery', nonSubscriptionDocument, { roomId: 'room-13-query' })).toThrow(
      'document must contain exactly one subscription operation'
    );
    expect(() => createModel('RegistryInvalidFields', multiFieldDocument, { roomId: 'room-13-fields' })).toThrow(
      'document must contain exactly one root Field selection'
    );

    const missingDefinitions = { kind: 'Document' } as unknown as TypedDocumentNode<LiveData, LiveVariables>;
    const missingSelectionSet = {
      kind: 'Document',
      definitions: [{ kind: 'OperationDefinition', operation: 'subscription' }]
    } as unknown as TypedDocumentNode<LiveData, LiveVariables>;
    expect(() => createModel('RegistryMissingDefinitions', missingDefinitions, { roomId: 'room-13-missing-definitions' })).toThrow(
      'document must contain exactly one subscription operation'
    );
    expect(() => createModel('RegistryMissingSelection', missingSelectionSet, { roomId: 'room-13-missing-selection' })).toThrow(
      'document must contain exactly one root Field selection'
    );
  });

  it('isolates model and event identities while activating each declaration once', () => {
    const document = makeDocument();
    const firstVariables = { roomId: 'room-4a' };
    const secondVariables = { roomId: 'room-4b' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const firstModel = createModel('RegistryIdentityFirst', document, firstVariables);
    const secondModel = createModel('RegistryIdentitySecond', document, secondVariables);
    const firstListener = jest.fn();
    const secondListener = jest.fn();
    const unsubscribeFirst = registerCleanup(firstModel.events.changed.subscribe(firstListener));
    const unsubscribeSecond = registerCleanup(secondModel.events.changed.subscribe(secondListener));

    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = renderActivation(true);
    });

    const firstSubscriber = subscriberFor(subscribers, firstVariables);
    const secondSubscriber = subscriberFor(subscribers, secondVariables);
    expect(firstSubscriber.options.variables).toBe(firstVariables);
    expect(secondSubscriber.options.variables).toBe(secondVariables);

    act(() => firstSubscriber.handlers.next({ payloadAlias: payload('first', 1) }));
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).not.toHaveBeenCalled();
    act(() => secondSubscriber.handlers.next({ payloadAlias: payload('second', 1) }));
    expect(secondListener).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    unsubscribeFirst();
    unsubscribeSecond();
  });

  it('fences callbacks from the old generation and keeps presentation listeners through reset', () => {
    const document = makeDocument();
    const variables = { roomId: 'room-5' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const model = createModel('RegistryReset', document, variables);
    const listener = jest.fn();
    const unsubscribe = registerCleanup(model.events.changed.subscribe(listener));

    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = renderActivation(true);
    });
    const oldSubscriber = subscriberFor(subscribers, variables);

    act(() => resetRuntime());
    expect(oldSubscriber.unsubscribe).toHaveBeenCalledTimes(1);
    const currentSubscribers = subscribers.filter(subscriber => subscriber.options.variables === variables);
    expect(currentSubscribers).toHaveLength(2);

    act(() => oldSubscriber.handlers.next({ payloadAlias: payload('stale', 1) }));
    expect(listener).not.toHaveBeenCalled();
    expect(model.find('stale')).toBeUndefined();

    act(() => currentSubscribers[1]!.handlers.next({ payloadAlias: payload('current', 2) }));
    expect(model.find('current')).toEqual(payload('current', 2).message);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(payload('current', 2));
    act(() => root.unmount());
    unsubscribe();
  });

  it('replaces a declaration in a new generation and preserves its presentation listeners', () => {
    const firstDocument = makeDocument('messageChanged', 'firstAlias');
    const secondDocument = makeDocument('messageChanged', 'secondAlias');
    const firstVariables = { roomId: 'room-14-first' };
    const secondVariables = { roomId: 'room-14-second' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const firstSelect = jest.fn((_context: { payload: LivePayload }) => null);
    const secondSelect = jest.fn((_context: { payload: LivePayload }) => null);
    const first = registerModelEvent(
      createRegistryRegistration('RegistryReplacement', firstDocument, firstVariables, { insert: { select: firstSelect } })
    );
    const listener = jest.fn();
    const unsubscribe = registerCleanup(first.subscribe(listener));
    const release = registerCleanup(acquireModelSubscriptions());
    const oldSubscriber = subscriberFor(subscribers, firstVariables);

    advanceRuntimeGeneration();
    registerModelEvent(
      createRegistryRegistration('RegistryReplacement', secondDocument, secondVariables, { insert: { select: secondSelect } })
    );

    const currentSubscriber = subscriberFor(subscribers, secondVariables);
    expect(oldSubscriber.unsubscribe).toHaveBeenCalledTimes(1);
    expect(currentSubscriber.options.query).toBe(secondDocument);
    expect(currentSubscriber.options.variables).toBe(secondVariables);
    expect(subscribers.filter(subscriber => subscriber.options.variables === secondVariables)).toHaveLength(1);

    const currentPayload = payload('replacement', 1);
    act(() => currentSubscriber.handlers.next({ secondAlias: currentPayload }));
    expect(secondSelect).toHaveBeenCalledWith({ payload: currentPayload });
    expect(listener).toHaveBeenCalledWith(currentPayload);
    expect(firstSelect).not.toHaveBeenCalled();

    release();
    unsubscribe();
  });

  it('retries a new-generation replacement after old transport teardown throws', () => {
    const oldDocument = makeDocument('messageChanged', 'oldAlias');
    const currentDocument = makeDocument('messageChanged', 'currentAlias');
    const oldVariables = { roomId: 'room-14-retry-old' };
    const currentVariables = { roomId: 'room-14-retry-current' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const registration = registerModelEvent(createRegistryRegistration('RegistryReplacementRetry', oldDocument, oldVariables));
    const listener = jest.fn();
    const unsubscribe = registerCleanup(registration.subscribe(listener));
    const release = registerCleanup(acquireModelSubscriptions());
    const oldSubscriber = subscriberFor(subscribers, oldVariables);
    const stopFailure = new Error('replacement unsubscribe failed');
    oldSubscriber.unsubscribe.mockImplementationOnce(() => {
      throw stopFailure;
    });
    const replacement = createRegistryRegistration('RegistryReplacementRetry', currentDocument, currentVariables);

    advanceRuntimeGeneration();
    expect(() => registerModelEvent(replacement)).toThrow(stopFailure);
    expect(subscribers.filter(subscriber => subscriber.options.variables === currentVariables)).toHaveLength(0);

    expect(() => registerModelEvent(replacement)).not.toThrow();
    const currentSubscriber = subscriberFor(subscribers, currentVariables);
    act(() => oldSubscriber.handlers.next({ oldAlias: payload('replacement-retry-old', 1) }));
    expect(listener).not.toHaveBeenCalled();

    const currentPayload = payload('replacement-retry-current', 2);
    act(() => currentSubscriber.handlers.next({ currentAlias: currentPayload }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(currentPayload);

    release();
    unsubscribe();
  });

  it('does not rewrite declaration generation while restarting a runtime', () => {
    const firstDocument = makeDocument('messageChanged', 'restartFirstAlias');
    const secondDocument = makeDocument('messageChanged', 'restartSecondAlias');
    const firstVariables = { roomId: 'room-15-first' };
    const secondVariables = { roomId: 'room-15-second' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    registerModelEvent(createRegistryRegistration('RegistryDeclarationGeneration', firstDocument, firstVariables));
    const release = registerCleanup(acquireModelSubscriptions());
    const oldSubscriber = subscriberFor(subscribers, firstVariables);

    advanceRuntimeGeneration();
    restartModelEventRegistry();

    registerModelEvent(createRegistryRegistration('RegistryDeclarationGeneration', secondDocument, secondVariables));

    expect(oldSubscriber.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscriberFor(subscribers, secondVariables).options.query).toBe(secondDocument);
    release();
  });

  it('restarts every active slot and aggregates synchronous subscribe failures', () => {
    const failingDocument = makeDocument('messageChanged', 'restartFailAlias');
    const succeedingDocument = makeDocument('messageChanged', 'restartSuccessAlias');
    const failingVariables = { roomId: 'room-16-failing' };
    const succeedingVariables = { roomId: 'room-16-succeeding' };
    const initial = createTransport();
    configureDb({ storage: createMemoryPlane(), transport: initial.transport });
    registerModelEvent(createRegistryRegistration('RegistryRestartFailure', failingDocument, failingVariables));
    registerModelEvent(createRegistryRegistration('RegistryRestartSuccess', succeedingDocument, succeedingVariables));
    const release = registerCleanup(acquireModelSubscriptions());
    subscriberFor(initial.subscribers, failingVariables);
    subscriberFor(initial.subscribers, succeedingVariables);

    const failure = new Error('restart subscribe failed');
    const attempts: Subscriber['options'][] = [];
    const replacement = createTransport((_handlers, options) => {
      attempts.push(options);
      if (options.variables === failingVariables) throw failure;
    });
    setDbTransport(replacement.transport);

    let thrown: unknown;
    try {
      restartModelEventRegistry();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const errors = thrown instanceof AggregateError ? thrown.errors : [];
    expect(errors).toContain(failure);
    expect(attempts.filter(options => options.variables === failingVariables)).toHaveLength(1);
    expect(attempts.filter(options => options.variables === succeedingVariables)).toHaveLength(1);
    expect(subscriberFor(replacement.subscribers, succeedingVariables).options.query).toBe(succeedingDocument);
    release();
  });

  it('continues all restart stops before activating every owned slot when one unsubscribe throws', () => {
    const document = makeDocument();
    const failingVariables = { roomId: 'room-16-stop-failing' };
    const succeedingVariables = { roomId: 'room-16-stop-succeeding' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    registerModelEvent(createRegistryRegistration('RegistryRestartStopFailure', document, failingVariables));
    registerModelEvent(createRegistryRegistration('RegistryRestartStopSuccess', document, succeedingVariables));
    const release = registerCleanup(acquireModelSubscriptions());
    const failingSubscriber = subscriberFor(subscribers, failingVariables);
    const succeedingSubscriber = subscriberFor(subscribers, succeedingVariables);
    const stopFailure = new Error('restart unsubscribe failed');
    failingSubscriber.unsubscribe.mockImplementationOnce(() => {
      throw stopFailure;
    });

    let thrown: unknown;
    try {
      restartModelEventRegistry();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const errors = thrown instanceof AggregateError ? thrown.errors : [];
    expect(errors).toContain(stopFailure);
    expect(failingSubscriber.unsubscribe).toHaveBeenCalledTimes(1);
    expect(succeedingSubscriber.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribers.filter(subscriber => subscriber.options.variables === failingVariables)).toHaveLength(2);
    expect(subscribers.filter(subscriber => subscriber.options.variables === succeedingVariables)).toHaveLength(2);
    release();
  });

  it('rebinds an active declaration to a new configured transport', () => {
    const document = makeDocument();
    const variables = { roomId: 'room-6' };
    const first = createTransport();
    configureDb({ storage: createMemoryPlane(), transport: first.transport });
    createModel('RegistryRebind', document, variables);

    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = renderActivation(true);
    });
    const firstSubscriber = subscriberFor(first.subscribers, variables);

    const second = createTransport();
    act(() => {
      configureDb({ storage: createMemoryPlane(), transport: second.transport });
    });

    expect(firstSubscriber.unsubscribe).toHaveBeenCalledTimes(1);
    subscriberFor(second.subscribers, variables);
    act(() => root.unmount());
  });

  it('cancels pending debounce delivery when the last active owner unmounts', () => {
    jest.useFakeTimers();
    const document = makeDocument();
    const variables = { roomId: 'room-7' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const model = createModel('RegistryDebounce', document, variables, { ms: 100 });
    const listener = jest.fn();
    const unsubscribe = registerCleanup(model.events.changed.subscribe(listener));

    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = renderActivation(true);
    });
    const subscriber = subscriberFor(subscribers, variables);
    act(() => subscriber.handlers.next({ payloadAlias: payload('debounced', 1) }));
    expect(listener).not.toHaveBeenCalled();

    act(() => root.unmount());
    act(() => jest.advanceTimersByTime(100));
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('cancels pending retry when the last active owner unmounts', () => {
    jest.useFakeTimers();
    const retryAttempts = jest.fn();
    const onSubscribe = (handlers: Subscriber['handlers'], options: Subscriber['options']) => {
      if ((options.variables as LiveVariables | undefined)?.roomId !== 'room-8') return;
      retryAttempts();
      handlers.error(new Error('retry'));
    };
    const { transport, subscribers } = createTransport(onSubscribe);
    const document = makeDocument();
    const variables = { roomId: 'room-8' };
    configureDb({ storage: createMemoryPlane(), transport });
    createModel('RegistryRetry', document, variables);

    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = renderActivation(true);
    });
    subscriberFor(subscribers, variables);

    act(() => root.unmount());
    act(() => jest.advanceTimersByTime(1000));
    expect(subscriberFor(subscribers, variables)).toBeDefined();
    expect(retryAttempts).toHaveBeenCalledTimes(1);
  });

  it('reports presentation listener failures without blocking later listeners', () => {
    const onSyncError = jest.fn();
    const document = makeDocument();
    const variables = { roomId: 'room-9' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport, defaults: { onSyncError } });
    const model = createModel('RegistryListenerErrors', document, variables);
    const firstListener = jest.fn(() => {
      throw new Error('listener failed');
    });
    const secondListener = jest.fn();
    const unsubscribeFirst = registerCleanup(model.events.changed.subscribe(firstListener));
    const unsubscribeSecond = registerCleanup(model.events.changed.subscribe(secondListener));

    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = renderActivation(true);
    });
    const subscriber = subscriberFor(subscribers, variables);
    act(() => subscriber.handlers.next({ payloadAlias: payload('listener-error', 1) }));

    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledTimes(1);
    expect(onSyncError).toHaveBeenCalledWith(expect.any(Error), { source: 'model-event', model: 'RegistryListenerErrors', event: 'changed' });
    act(() => root.unmount());
    unsubscribeFirst();
    unsubscribeSecond();
  });

  it('continues every last-owner stop when one unsubscribe throws', () => {
    const document = makeDocument();
    const failingVariables = { roomId: 'room-17-release-failing' };
    const succeedingVariables = { roomId: 'room-17-release-succeeding' };
    const { transport, subscribers } = createTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    registerModelEvent(createRegistryRegistration('RegistryReleaseStopFailure', document, failingVariables));
    registerModelEvent(createRegistryRegistration('RegistryReleaseStopSuccess', document, succeedingVariables));
    const release = registerCleanup(acquireModelSubscriptions());
    const failingSubscriber = subscriberFor(subscribers, failingVariables);
    const succeedingSubscriber = subscriberFor(subscribers, succeedingVariables);
    const stopFailure = new Error('release unsubscribe failed');
    failingSubscriber.unsubscribe.mockImplementationOnce(() => {
      throw stopFailure;
    });

    let thrown: unknown;
    try {
      release();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const errors = thrown instanceof AggregateError ? thrown.errors : [];
    expect(errors).toContain(stopFailure);
    expect(failingSubscriber.unsubscribe).toHaveBeenCalledTimes(1);
    expect(succeedingSubscriber.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('aggregates acquisition and cleanup failures without leaving an owner active', () => {
    const document = makeDocument();
    const firstVariables = { roomId: 'room-acquire-first' };
    const secondVariables = { roomId: 'room-acquire-second' };
    configureDb({ storage: createMemoryPlane(), transport: createTransport().transport });
    registerModelEvent(createRegistryRegistration('RegistryAcquireFirst', document, firstVariables));
    registerModelEvent(createRegistryRegistration('RegistryAcquireSecond', document, secondVariables));
    const cleanupFailure = new Error('acquire cleanup failed');
    const subscribeFailure = new AggregateError([new Error('inner subscribe failure')], 'acquire subscribe failed');
    let subscribeCount = 0;
    setDbTransport({
      ...createTransport().transport,
      subscribe() {
        subscribeCount += 1;
        if (subscribeCount === 2) throw subscribeFailure;
        return () => {
          throw cleanupFailure;
        };
      }
    });

    let thrown: unknown;
    try {
      acquireModelSubscriptions();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const errors = thrown instanceof AggregateError ? thrown.errors : [];
    expect(errors).toEqual([subscribeFailure.errors[0], cleanupFailure]);
    expect(subscribeCount).toBe(2);
  });

  it('wraps a direct acquisition failure', () => {
    const document = makeDocument();
    const variables = { roomId: 'room-acquire-direct-failure' };
    configureDb({ storage: createMemoryPlane(), transport: createTransport().transport });
    registerModelEvent(createRegistryRegistration('RegistryAcquireDirectFailure', document, variables));
    const failure = new Error('direct subscribe failure');
    setDbTransport({
      ...createTransport().transport,
      subscribe() {
        throw failure;
      }
    });

    let thrown: unknown;
    try {
      acquireModelSubscriptions();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown instanceof AggregateError ? thrown.errors : []).toEqual([failure]);
  });
});
