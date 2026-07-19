"use strict";

import { expandPlan } from "../core/relations.js";
import { getApplyRuntime, getDbRuntimeConfig, getOperationState } from "./configure.js";
import { getDbLogger } from "../core/logger.js";
import { getDbSubscriptionEffect } from "../core/subscriptionRuntime.js";
import { getInternalModelHandle } from "../core/internalHandles.js";
const modelsByName = new Map();

/** Register a model for the named-model lookup exposed to fused custom ingest handlers. */
export const registerIngestModel = (name, model) => {
  modelsByName.set(name, model);
};
const idOf = payload => {
  if (typeof payload === 'string') return payload;
  const id = payload?.id;
  return typeof id === 'string' ? id : null;
};
const reportModelIngestError = (model, event, error) => {
  const reported = error instanceof Error ? error : new Error(String(error));
  try {
    getDbRuntimeConfig().defaults?.onSyncError?.(reported, {
      source: 'ingest',
      model: model.modelId,
      event
    });
  } catch (observerError) {
    getDbLogger().error('defineIngest onSyncError failed', {
      error: observerError
    });
  }
};

/**
 * Fuse model-owned subscription declarations with the existing ingest apply pipeline.
 *
 * @param model Model receiving mechanical rows and exposed to custom handlers.
 * @param entries Subscription event declarations keyed by their root-field name.
 * @returns Subscription entries accepted directly by `createDbSubscriptionRuntime`.
 */
export const defineModelIngest = (model, entries) => {
  const deliver = (event, entry, data) => {
    if (entry.handler) {
      defineIngest(model, {
        [event]: entry.handler
      }).apply(event, data);
      return;
    }
    const payload = entry.payload ? entry.payload(data) : data;
    try {
      if (entry.echoGuard?.(payload)) return;
      if (entry.guard === 'existing' && !model.get(idOf(payload))) return;
      if (typeof entry.guard === 'function' && !entry.guard(payload)) return;
      const runEffect = () => {
        if (!entry.effect) return;
        const effect = getDbSubscriptionEffect(entry.effect.name);
        if (!effect) throw new Error(`Unknown subscription effect ${entry.effect.name}`);
        effect(payload);
      };
      if (entry.effect?.when === 'before') runEffect();
      if (typeof entry.apply === 'function') {
        const tools = {
          model,
          invalidate: () => model.invalidate(),
          operations: getOperationState(),
          get models() {
            return Object.fromEntries(modelsByName);
          }
        };
        entry.apply(payload, tools);
      } else if (entry.apply === 'destroy') {
        const id = idOf(payload);
        if (id) defineIngest(model, {
          [event]: () => ({
            destroy: id
          })
        }).apply(event, payload);
      } else {
        defineIngest(model, {
          [event]: next => ({
            upsert: next
          })
        }).apply(event, payload);
      }
      if (entry.effect?.when === 'after') runEffect();
    } catch (error) {
      reportModelIngestError(model, event, error);
    }
  };
  const compiled = Object.entries(entries).map(([event, entry]) => ({
    key: event,
    query: entry.document,
    debounce: entry.debounce,
    onData: data => deliver(event, entry, data)
  }));
  return {
    entries: compiled,
    apply: (key, payload) => {
      const entry = entries[key];
      if (entry) deliver(key, entry, payload);
    }
  };
};

/**
 * Compile a subscription event into ONE event plan: rows, destroys and extract sinks apply with
 * relation side effects (touch/counterCache/dependent) in a single epoch. Version arbitration for
 * stale events lives in the model's merge.shouldOverwrite gate - not here (one gate, no zoo).
 */
export const defineIngest = (model, handlers) => ({
  apply: (event, payload) => {
    try {
      const declaration = handlers[event]?.(payload) ?? null;
      if (!declaration) return null;
      if (declaration.operationId && getOperationState().hasCommitted(declaration.operationId)) return declaration;
      const rows = declaration.upsert == null ? [] : Array.isArray(declaration.upsert) ? declaration.upsert : [declaration.upsert];
      const ids = declaration.destroy == null ? [] : Array.isArray(declaration.destroy) ? declaration.destroy : [declaration.destroy];
      const ops = [];
      if (rows.length > 0) {
        ops.push(...getInternalModelHandle(model).planRows(rows).map(op => op.kind === 'upsert' ? {
          ...op,
          origin: 'event'
        } : op));
      }
      if (ids.length > 0) ops.push({
        kind: 'destroy',
        model: model.modelId,
        ids
      });
      for (const sink of declaration.extract ?? []) {
        ops.push(...getInternalModelHandle(sink.into).planRows(sink.rows).map(op => op.kind === 'upsert' ? {
          ...op,
          origin: 'event'
        } : op));
      }
      if (ops.length > 0) getApplyRuntime().apply(expandPlan(ops));
      if (declaration.invalidate) model.invalidate();
      return declaration;
    } catch (error) {
      const reported = error instanceof Error ? error : new Error(String(error));
      try {
        getDbRuntimeConfig().defaults?.onSyncError?.(reported, {
          source: 'ingest',
          model: model.modelId,
          event
        });
      } catch (observerError) {
        getDbLogger().error('defineIngest onSyncError failed', {
          error: observerError
        });
      }
      return null;
    }
  }
});
//# sourceMappingURL=defineIngest.js.map