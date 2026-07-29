"use strict";

import { union } from 'es-toolkit';
import { publishProjectedBatch } from "./store.js";
import { flushPersistence, getCommitBus, getOperationState, getRuntimeGeneration, noteMaintenancePersistence } from "../dsl/configure.js";
import { compositeKey } from "./serialize.js";
import { noteDataLoss } from "./diagnostics.js";
import { runPendingTempRowMaintenance } from "../dsl/maintenanceRegistry.js";
const hosts = new Map();
const hostGenerations = new Map();

/** Registered once per defineModel; survives resetRuntime like apply targets. */
export const registerGcHost = (modelId, host) => {
  const generation = getRuntimeGeneration();
  if (hosts.has(modelId) && hostGenerations.get(modelId) === generation) throw new Error(`GC host already registered for model ${modelId}`);
  hosts.set(modelId, host);
  hostGenerations.set(modelId, generation);
  return () => {
    if (hosts.get(modelId) !== host) return;
    hosts.delete(modelId);
    hostGenerations.delete(modelId);
  };
};

/**
 * Reachability GC over all registered models. Roots: scope members, exempt models, pending
 * operations, mounted readers, and non-idle scopes. Edges: belongsTo/references of live rows.
 * Unreached rows are evicted (no tombstones), dead and opt-in idle scope keys removed, then
 * persistence flushes. Mounted readers are GC roots, so this is safe during in-session UI rendering.
 *
 * `bootDb`/`suspendDb` call this for you as part of the recommended startup/teardown sequence; call it
 * directly only for a different sweep cadence.
 *
 * @returns Reachability report with evicted row and removed scope counts by model.
 */
export const collectGarbage = () => {
  const marked = new Map();
  const queue = [];
  const maintainedModels = new Set();
  const rows = [];
  const scopes = [];
  const scopeChanges = [];
  const report = {
    evicted: {},
    scopesRemoved: {}
  };
  // Age-based unresolved temp cleanup deliberately precedes reachability marking: scope membership and
  // mounted readers are ordinary GC roots, but an expired temp id is an explicit retention exception.
  runPendingTempRowMaintenance();
  const noteScopeRemoval = (host, key) => {
    report.scopesRemoved[host.modelId] = (report.scopesRemoved[host.modelId] ?? 0) + 1;
    maintainedModels.add(host.modelId);
    scopes.push({
      model: host.modelId,
      scopeKey: key
    });
    scopeChanges.push({
      model: host.modelId,
      scopeKey: key,
      entries: []
    });
    noteDataLoss('gc-scope-removal', host.modelId, 1);
  };
  const mark = (model, id) => {
    const host = hosts.get(model);
    if (!host || !host.hasRow(id)) return;
    let set = marked.get(model);
    if (!set) {
      set = new Set();
      marked.set(model, set);
    }
    if (set.has(id)) return;
    set.add(id);
    queue.push({
      model,
      id
    });
  };
  const activeScopeDependencies = new Set(getCommitBus().activeDependencies().filter(dependency => dependency.kind === 'scope').map(dependency => compositeKey(dependency.model, dependency.scopeKey)));
  const now = Date.now();
  for (const host of hosts.values()) {
    const threshold = host.idleScopeAfterMs?.();
    if (!host.exempt && threshold !== undefined) {
      for (const key of host.scopeKeys()) {
        if (activeScopeDependencies.has(compositeKey(host.modelId, key))) continue;
        const lastAccess = host.scopeLastAccess?.(key);
        if (lastAccess !== undefined && now - lastAccess <= threshold) continue;
        host.removeScope(key);
        noteScopeRemoval(host, key);
      }
    }
  }
  for (const host of hosts.values()) {
    if (host.exempt) {
      for (const id of host.rowIds()) mark(host.modelId, id);
      continue;
    }
    for (const key of host.scopeKeys()) {
      const dead = [];
      for (const id of host.scopeEntryIds(key)) {
        if (host.hasRow(id)) mark(host.modelId, id);else dead.push(id);
      }
      if (dead.length > 0) {
        host.detachScopeEntries(key, dead);
        maintainedModels.add(host.modelId);
        scopes.push({
          model: host.modelId,
          scopeKey: key
        });
        scopeChanges.push({
          model: host.modelId,
          scopeKey: key,
          detachIds: dead
        });
        noteDataLoss('gc-scope-membership-detach', host.modelId, dead.length);
      }
    }
  }
  for (const operation of getOperationState().open()) {
    for (const id of union(operation.tempIds, operation.rowIds ?? [])) mark(operation.model, id);
  }
  for (const dependency of getCommitBus().activeDependencies()) {
    if (dependency.kind === 'row') mark(dependency.model, dependency.id);
    if (dependency.kind === 'model') {
      const host = hosts.get(dependency.model);
      if (host) for (const id of host.rowIds()) mark(dependency.model, id);
    }
  }
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const {
      model,
      id
    } = queue[queueIndex++];
    const host = hosts.get(model);
    if (!host) continue;
    for (const reference of host.referencesOf(id)) mark(reference.model, reference.id);
  }
  for (const host of hosts.values()) {
    if (host.exempt) continue;
    const live = marked.get(host.modelId);
    let evicted = 0;
    for (const id of host.rowIds()) {
      if (live?.has(id)) continue;
      if (host.evict(id)) {
        evicted += 1;
        rows.push({
          model: host.modelId,
          id,
          fields: null,
          kind: 'destroy'
        });
      }
    }
    if (evicted > 0) {
      report.evicted[host.modelId] = evicted;
      maintainedModels.add(host.modelId);
      noteDataLoss('gc-row-eviction', host.modelId, evicted);
    }
    for (const key of host.scopeKeys()) {
      if (host.scopeEntryCount(key) > 0) continue;
      host.removeScope(key);
      noteScopeRemoval(host, key);
    }
  }
  if (maintainedModels.size > 0) {
    const models = [...maintainedModels];
    noteMaintenancePersistence(models);
    publishProjectedBatch(getCommitBus(), {
      rows,
      scopes,
      mode: 'maintenance',
      scopeChanges,
      maintenanceModels: models
    });
  }
  flushPersistence();
  return report;
};
//# sourceMappingURL=gc.js.map