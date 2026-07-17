import { flushPersistence, getCommitBus, getOperationState, noteMaintenancePersistence } from '../dsl/configure';

export type GcHost = {
  modelId: string;
  exempt: boolean;
  rowIds(): string[];
  hasRow(id: string): boolean;
  scopeKeys(): string[];
  scopeEntryIds(key: string): string[];
  detachScopeEntries(key: string, ids: string[]): void;
  scopeEntryCount(key: string): number;
  removeScope(key: string): void;
  evict(id: string): boolean;
  referencesOf(id: string): Array<{ model: string; id: string }>;
};

const hosts = new Map<string, GcHost>();

/** Registered once per defineModel; survives resetRuntime like apply targets. */
export const registerGcHost = (modelId: string, host: GcHost): (() => void) => {
  hosts.set(modelId, host);
  return () => hosts.delete(modelId);
};

export type GcReport = { evicted: Record<string, number>; scopesRemoved: Record<string, number> };

/**
 * Reachability GC over all registered models. Roots: scope members, exempt models, pending
 * operations. Edges: belongsTo/references of live rows. Unreached rows are evicted (no
 * tombstones), dead scope entries detached, empty scope keys removed, then persistence flushes.
 * Run at startup after replayJournal - NOT while UI renders unscoped detail rows.
 */
export const collectGarbage = (): GcReport => {
  const marked = new Map<string, Set<string>>();
  const queue: Array<{ model: string; id: string }> = [];
  const maintainedModels = new Set<string>();
  const rows: Array<{ model: string; id: string; fields: null }> = [];
  const scopes: Array<{ model: string; scopeKey: string }> = [];
  const scopeChanges: Array<{ model: string; scopeKey: string; detachIds?: string[]; rebuild?: boolean }> = [];
  const mark = (model: string, id: string): void => {
    const host = hosts.get(model);
    if (!host || !host.hasRow(id)) return;
    let set = marked.get(model);
    if (!set) {
      set = new Set();
      marked.set(model, set);
    }
    if (set.has(id)) return;
    set.add(id);
    queue.push({ model, id });
  };

  for (const host of hosts.values()) {
    if (host.exempt) {
      for (const id of host.rowIds()) mark(host.modelId, id);
      continue;
    }
    for (const key of host.scopeKeys()) {
      const dead: string[] = [];
      for (const id of host.scopeEntryIds(key)) {
        if (host.hasRow(id)) mark(host.modelId, id);
        else dead.push(id);
      }
      if (dead.length > 0) {
        host.detachScopeEntries(key, dead);
        maintainedModels.add(host.modelId);
        scopes.push({ model: host.modelId, scopeKey: key });
        scopeChanges.push({ model: host.modelId, scopeKey: key, detachIds: dead });
      }
    }
  }
  for (const operation of getOperationState().pending()) {
    for (const id of operation.tempIds) mark(operation.model, id);
  }

  while (queue.length > 0) {
    const { model, id } = queue.shift() as { model: string; id: string };
    const host = hosts.get(model);
    if (!host) continue;
    for (const reference of host.referencesOf(id)) mark(reference.model, reference.id);
  }

  const report: GcReport = { evicted: {}, scopesRemoved: {} };
  for (const host of hosts.values()) {
    if (host.exempt) continue;
    const live = marked.get(host.modelId);
    let evicted = 0;
    for (const id of host.rowIds()) {
      if (live?.has(id)) continue;
      if (host.evict(id)) {
        evicted += 1;
        rows.push({ model: host.modelId, id, fields: null });
      }
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
      scopes.push({ model: host.modelId, scopeKey: key });
      scopeChanges.push({ model: host.modelId, scopeKey: key, rebuild: true });
    }
    if (scopesRemoved > 0) {
      report.scopesRemoved[host.modelId] = scopesRemoved;
      maintainedModels.add(host.modelId);
    }
  }
  if (maintainedModels.size > 0) {
    const models = [...maintainedModels];
    noteMaintenancePersistence(models);
    getCommitBus().publish({ rows, scopes, mode: 'maintenance', scopeChanges, maintenanceModels: models });
  }

  flushPersistence();
  return report;
};
