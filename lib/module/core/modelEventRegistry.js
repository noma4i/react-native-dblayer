"use strict";

import { compositeKey } from "./serialize.js";
import { reportSyncError } from "./syncError.js";
import { createModelEventLifecycle } from "./subscriptionLifecycle.js";
import { createGenerationRegistry } from "./generationRegistry.js";
import { createGenerationFence } from "../utils/runtimeGeneration.js";
import { createCommitEnvelope } from "./apply/commitEnvelope.js";
import { getApplyRuntime } from "../dsl/configure.js";
import { compileModelRootPlan } from "../dsl/modelRootPlan.js";
import { createWritePlanCollector, runWritePlanInvalidations, stampCausalRevision } from "../dsl/writePlan.js";
const declarations = createGenerationRegistry();
const slots = new Map();
const activeOwners = new Set();
const documentPayloadKey = (document, modelKey, eventName) => {
  const definitions = document.definitions;
  const operations = Array.isArray(definitions) ? definitions.filter(definition => {
    return typeof definition === 'object' && definition !== null && definition.kind === 'OperationDefinition';
  }) : [];
  if (operations.length !== 1 || operations[0].operation !== 'subscription') {
    throw new Error(`${modelKey}.${eventName}: document must contain exactly one subscription operation`);
  }
  const selections = operations[0].selectionSet?.selections ?? [];
  if (selections.length !== 1 || selections[0].kind !== 'Field') {
    throw new Error(`${modelKey}.${eventName}: document must contain exactly one root Field selection`);
  }
  const field = selections[0];
  return field.alias?.value ?? field.name.value;
};
const notifyListeners = (slot, payload) => {
  for (const listener of [...slot.listeners]) {
    try {
      listener(payload);
    } catch (error) {
      reportSyncError(error, {
        source: 'model-event',
        model: slot.modelKey,
        event: slot.eventName
      }, 'modelEventRegistry');
    }
  }
};
const stopSlot = slot => {
  const runtime = slot.runtime;
  slot.runtime = null;
  runtime?.stop();
};
const deliver = (slot, registration, payload, generationFence, baseRevision) => {
  let planned;
  try {
    planned = registration.plan(payload);
  } catch (error) {
    reportSyncError(error, {
      source: 'model-event',
      model: slot.modelKey,
      event: slot.eventName
    }, 'modelEventRegistry');
    return false;
  }
  if (slot.generationFence !== generationFence || !generationFence.isCurrent()) return false;
  let envelope;
  try {
    envelope = createCommitEnvelope(stampCausalRevision(planned.writeOps, baseRevision));
  } catch (error) {
    reportSyncError(error, {
      source: 'model-event',
      model: slot.modelKey,
      event: slot.eventName
    }, 'modelEventRegistry');
    return false;
  }
  const hasWriteWork = envelope.entityOps.length > 0 || envelope.scopeOps.length > 0 || envelope.operationTransitions.length > 0;
  if (!hasWriteWork && planned.invalidations.length === 0) return false;
  try {
    if (hasWriteWork) getApplyRuntime().commit(envelope);
  } catch (error) {
    reportSyncError(error, {
      source: 'model-event',
      model: slot.modelKey,
      event: slot.eventName
    }, 'modelEventRegistry');
    return false;
  }
  if (slot.generationFence !== generationFence || !generationFence.isCurrent()) return false;
  if (planned.invalidations.length > 0 && !runWritePlanInvalidations(planned.invalidations, generationFence.isCurrent, error => reportSyncError(error, {
    source: 'model-event',
    model: slot.modelKey,
    event: slot.eventName
  }, 'modelEventRegistry'))) {
    return false;
  }
  return hasWriteWork || planned.invalidations.length > 0;
};
const createRuntime = slot => {
  const generationFence = slot.generationFence;
  const registration = slot.current;
  const entry = {
    key: slot.identity,
    payloadKey: registration.payloadKey,
    query: registration.document,
    vars: registration.variables,
    debounce: registration.debounce,
    onData: payload => {
      const baseRevision = getApplyRuntime().currentEpoch();
      if (!deliver(slot, registration, payload, generationFence, baseRevision)) return;
      notifyListeners(slot, payload);
    }
  };
  return createModelEventLifecycle([entry]);
};
const activateSlot = slot => {
  if (slot.owners.size === 0) return;
  if (!slot.runtime) slot.runtime = createRuntime(slot);
  try {
    slot.runtime.setActive(true);
  } catch (error) {
    stopSlot(slot);
    throw error;
  }
};
const releaseOwner = token => {
  activeOwners.delete(token);
  const errors = [];
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
export const acquireModelSubscriptions = () => {
  const token = Symbol('model-event-owner');
  activeOwners.add(token);
  try {
    for (const slot of slots.values()) {
      slot.owners.add(token);
      activateSlot(slot);
    }
  } catch (error) {
    const errors = error instanceof AggregateError ? [...error.errors] : [error];
    try {
      releaseOwner(token);
    } catch (cleanupError) {
      errors.push(...cleanupError.errors);
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
export const registerModelEvent = registration => {
  const identity = compositeKey(registration.modelKey, registration.eventName);
  const errorMessage = `Model event already registered for ${registration.modelKey}.${registration.eventName}`;
  declarations.assertCanRegister(identity, errorMessage);
  const payloadKey = documentPayloadKey(registration.document, registration.modelKey, registration.eventName);
  const current = {
    document: registration.document,
    variables: registration.variables,
    debounce: registration.debounce,
    plan: payload => {
      const rootOps = compileModelRootPlan(registration.owner, registration.root, {
        payload: payload
      });
      const collector = createWritePlanCollector({
        ownerKey: registration.modelKey,
        origin: 'event'
      });
      registration.write?.({
        payload: payload
      }, collector.plan);
      const compiled = collector.compile();
      return {
        writeOps: [...rootOps, ...compiled.writeOps],
        invalidations: compiled.invalidations
      };
    },
    payloadKey
  };
  const existing = slots.get(identity);
  if (existing) stopSlot(existing);
  declarations.register(identity, current, errorMessage);
  const stored = declarations.get(identity);
  const slot = existing ?? {
    identity,
    modelKey: registration.modelKey,
    eventName: registration.eventName,
    generationFence: createGenerationFence(),
    current: stored,
    runtime: null,
    owners: new Set(activeOwners),
    listeners: new Set()
  };
  if (existing) {
    existing.generationFence = createGenerationFence();
    existing.current = stored;
  } else {
    slots.set(identity, slot);
  }
  activateSlot(slot);
  return {
    subscribe(listener) {
      slot.listeners.add(listener);
      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        slot.listeners.delete(listener);
      };
    }
  };
};
export const restartModelEventRegistry = () => {
  const errors = [];
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
//# sourceMappingURL=modelEventRegistry.js.map