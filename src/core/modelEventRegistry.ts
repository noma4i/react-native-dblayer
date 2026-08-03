import type { DocumentNode, FieldNode, OperationDefinitionNode } from 'graphql';
import { compositeKey } from './serialize';
import { reportSyncError } from './syncError';
import { createModelEventLifecycle } from './subscriptionLifecycle';
import { createGenerationRegistry } from './generationRegistry';
import { createGenerationFence } from '../utils/runtimeGeneration';
import { createCommitEnvelope } from './apply/commitEnvelope';
import { getApplyRuntime } from '../dsl/configure';
import { compileModelRootPlan } from '../dsl/modelRootPlan';
import { createWritePlanCollector, runWritePlanInvalidations, stampCausalRevision } from '../dsl/writePlan';
import type {
  ModelEventLifecycleEntry,
  ModelEventLifecycle,
  ModelEventRegistration,
  ModelEventSlot,
  ModelEventSubscription,
  StoredModelEventRegistration
} from '../types';

const declarations = createGenerationRegistry<StoredModelEventRegistration>();
const slots = new Map<string, ModelEventSlot>();
const activeOwners = new Set<symbol>();

const documentPayloadKey = (document: DocumentNode, modelKey: string, eventName: string): string => {
  const definitions = (document as DocumentNode | { definitions?: unknown }).definitions;
  const operations = Array.isArray(definitions)
    ? definitions.filter((definition): definition is OperationDefinitionNode => {
        return typeof definition === 'object' && definition !== null && (definition as { kind?: unknown }).kind === 'OperationDefinition';
      })
    : [];
  if (operations.length !== 1 || operations[0]!.operation !== 'subscription') {
    throw new Error(`${modelKey}.${eventName}: document must contain exactly one subscription operation`);
  }
  const selections = operations[0]!.selectionSet?.selections ?? [];
  if (selections.length !== 1 || selections[0]!.kind !== 'Field') {
    throw new Error(`${modelKey}.${eventName}: document must contain exactly one root Field selection`);
  }
  const field = selections[0] as FieldNode;
  return field.alias?.value ?? field.name.value;
};

const notifyListeners = (slot: ModelEventSlot, payload: unknown): void => {
  for (const listener of [...slot.listeners]) {
    try {
      listener(payload);
    } catch (error) {
      reportSyncError(error, { source: 'model-event', model: slot.modelKey, event: slot.eventName }, 'modelEventRegistry');
    }
  }
};

const stopSlot = (slot: ModelEventSlot): void => {
  const runtime = slot.runtime;
  slot.runtime = null;
  runtime?.stop();
};

const deliver = (
  slot: ModelEventSlot,
  registration: StoredModelEventRegistration,
  payload: unknown,
  generationFence: ReturnType<typeof createGenerationFence>,
  baseRevision: number
): boolean => {
  let planned: ReturnType<StoredModelEventRegistration['plan']>;
  try {
    planned = registration.plan(payload);
  } catch (error) {
    reportSyncError(error, { source: 'model-event', model: slot.modelKey, event: slot.eventName }, 'modelEventRegistry');
    return false;
  }
  if (slot.generationFence !== generationFence || !generationFence.isCurrent()) return false;
  let envelope: ReturnType<typeof createCommitEnvelope>;
  try {
    envelope = createCommitEnvelope(
      stampCausalRevision(planned.writeOps, baseRevision)
    );
  } catch (error) {
    reportSyncError(error, { source: 'model-event', model: slot.modelKey, event: slot.eventName }, 'modelEventRegistry');
    return false;
  }
  const hasWriteWork = envelope.entityOps.length > 0 || envelope.scopeOps.length > 0 || envelope.operationTransitions.length > 0;
  if (!hasWriteWork && planned.invalidations.length === 0) return false;
  try {
    if (hasWriteWork) getApplyRuntime().commit(envelope);
  } catch (error) {
    reportSyncError(error, { source: 'model-event', model: slot.modelKey, event: slot.eventName }, 'modelEventRegistry');
    return false;
  }
  if (slot.generationFence !== generationFence || !generationFence.isCurrent()) return false;
  if (
    planned.invalidations.length > 0 &&
    !runWritePlanInvalidations(
      planned.invalidations,
      generationFence.isCurrent,
      error => reportSyncError(error, { source: 'model-event', model: slot.modelKey, event: slot.eventName }, 'modelEventRegistry')
    )
  ) {
    return false;
  }
  return hasWriteWork || planned.invalidations.length > 0;
};

const createRuntime = (slot: ModelEventSlot): ModelEventLifecycle => {
  const generationFence = slot.generationFence;
  const registration = slot.current;
  const entry: ModelEventLifecycleEntry = {
    key: slot.identity,
    payloadKey: registration.payloadKey,
    query: registration.document,
    vars: registration.variables,
    debounce: registration.debounce as ModelEventLifecycleEntry['debounce'],
    onData: payload => {
      const baseRevision = getApplyRuntime().currentEpoch();
      if (!deliver(slot, registration, payload, generationFence, baseRevision)) return;
      notifyListeners(slot, payload);
    }
  };
  return createModelEventLifecycle([entry]);
};

const activateSlot = (slot: ModelEventSlot): void => {
  if (slot.owners.size === 0) return;
  if (!slot.runtime) slot.runtime = createRuntime(slot);
  try {
    slot.runtime.setActive(true);
  } catch (error) {
    stopSlot(slot);
    throw error;
  }
};

const releaseOwner = (token: symbol): void => {
  activeOwners.delete(token);
  const errors: unknown[] = [];
  for (const slot of slots.values()) {
    if (!slot.owners.delete(token) || slot.owners.size > 0) continue;
    try {
      stopSlot(slot);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'model event owner release failed');
};

export const acquireModelSubscriptions = (): (() => void) => {
  const token = Symbol('model-event-owner');
  activeOwners.add(token);
  try {
    for (const slot of slots.values()) {
      slot.owners.add(token);
      activateSlot(slot);
    }
  } catch (error) {
    const errors: unknown[] = error instanceof AggregateError ? [...error.errors] : [error];
    try {
      releaseOwner(token);
    } catch (cleanupError) {
      errors.push(...(cleanupError as AggregateError).errors);
    }
    throw new AggregateError(errors, 'model event owner acquisition failed');
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseOwner(token);
  };
};

export const registerModelEvent = <TPayload>(registration: ModelEventRegistration<TPayload>): ModelEventSubscription<TPayload> => {
  const identity = compositeKey(registration.modelKey, registration.eventName);
  const errorMessage = `Model event already registered for ${registration.modelKey}.${registration.eventName}`;
  declarations.assertCanRegister(identity, errorMessage);
  const payloadKey = documentPayloadKey(registration.document as DocumentNode, registration.modelKey, registration.eventName);
  const current: StoredModelEventRegistration = {
    document: registration.document,
    variables: registration.variables,
    debounce: registration.debounce as ModelEventLifecycleEntry['debounce'],
    plan: payload => {
      const rootOps = compileModelRootPlan(registration.owner, registration.root, { payload: payload as TPayload });
      const collector = createWritePlanCollector({ ownerKey: registration.modelKey, origin: 'event' });
      registration.write?.({ payload: payload as TPayload }, collector.plan);
      const compiled = collector.compile();
      return { writeOps: [...rootOps, ...compiled.writeOps], invalidations: compiled.invalidations };
    },
    payloadKey
  };
  const existing = slots.get(identity);
  if (existing) stopSlot(existing);
  declarations.register(identity, current, errorMessage);
  const stored = declarations.get(identity)!;
  const slot =
    existing ??
    ({
      identity,
      modelKey: registration.modelKey,
      eventName: registration.eventName,
      generationFence: createGenerationFence(),
      current: stored,
      runtime: null,
      owners: new Set(activeOwners),
      listeners: new Set()
    } satisfies ModelEventSlot);
  if (existing) {
    existing.generationFence = createGenerationFence();
    existing.current = stored;
  } else {
    slots.set(identity, slot);
  }
  activateSlot(slot);
  return {
    subscribe(listener) {
      slot.listeners.add(listener as (payload: unknown) => void);
      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        slot.listeners.delete(listener as (payload: unknown) => void);
      };
    }
  };
};

export const restartModelEventRegistry = (): void => {
  const errors: unknown[] = [];
  for (const slot of slots.values()) {
    try {
      stopSlot(slot);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const slot of slots.values()) {
    slot.generationFence = createGenerationFence();
    if (slot.owners.size === 0) continue;
    try {
      activateSlot(slot);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'model event registry restart failed');
};
