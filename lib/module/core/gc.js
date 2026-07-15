"use strict";

import { flushPersistence, getCommitBus, getOperationState, noteMaintenancePersistence } from "../dsl/configure.js";
const hosts = new Map();

/** Registered once per defineModel; survives resetRuntime like apply targets. */
export const registerGcHost = (modelId, host) => {
  hosts.set(modelId, host);
  return () => hosts.delete(modelId);
};
/**
 * Reachability GC over all registered models. Roots: scope members, exempt models, pending
 * operations. Edges: belongsTo/references of live rows. Unreached rows are evicted (no
 * tombstones), dead scope entries detached, empty scope keys removed, then persistence flushes.
 * Run at startup after replayJournal - NOT while UI renders unscoped detail rows.
 */
export const collectGarbage = () => {
  const marked = new Map();
  const queue = [];
  const maintainedModels = new Set();
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
      }
    }
  }
  for (const operation of getOperationState().pending()) {
    for (const id of operation.tempIds) mark(operation.model, id);
  }
  while (queue.length > 0) {
    const {
      model,
      id
    } = queue.shift();
    const host = hosts.get(model);
    if (!host) continue;
    for (const reference of host.referencesOf(id)) mark(reference.model, reference.id);
  }
  const report = {
    evicted: {},
    scopesRemoved: {}
  };
  for (const host of hosts.values()) {
    if (host.exempt) continue;
    const live = marked.get(host.modelId);
    let evicted = 0;
    for (const id of host.rowIds()) {
      if (live?.has(id)) continue;
      if (host.evict(id)) evicted += 1;
    }
    if (evicted > 0) {
      report.evicted[host.modelId] = evicted;
      maintainedModels.add(host.modelId);
    }
    let scopesRemoved = 0;
    for (const key of host.scopeKeys()) {
      if (host.scopeEntryCount(key) > 0) continue;
      host.removeScope(key);
      scopesRemoved += 1;
    }
    if (scopesRemoved > 0) {
      report.scopesRemoved[host.modelId] = scopesRemoved;
      maintainedModels.add(host.modelId);
    }
  }
  if (maintainedModels.size > 0) {
    const models = [...maintainedModels];
    noteMaintenancePersistence(models);
    getCommitBus().publish({
      rows: models.map(model => ({
        model,
        id: '__maintenance__',
        fields: null
      })),
      scopes: []
    });
  }
  flushPersistence();
  return report;
};
//# sourceMappingURL=gc.js.map