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
  idleScopeAfterMs?(): number | undefined;
  scopeLastAccess?(key: string): number | undefined;
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
 * operations, mounted readers, and non-idle scopes. Edges: belongsTo/references of live rows.
 * Unreached rows are evicted (no tombstones), dead and opt-in idle scope keys removed, then
 * persistence flushes. Mounted readers are GC roots, so this is safe during in-session UI rendering.
 *
 * `bootDb`/`suspendDb` call this for you as part of the recommended startup/teardown sequence; call it
 * directly only for a different sweep cadence.
 *
 * @returns Reachability report with evicted row and removed scope counts by model.
 */
export const collectGarbage = (): GcReport => {
  const marked = new Map<string, Set<string>>();
  const queue: Array<{ model: string; id: string }> = [];
  const maintainedModels = new Set<string>();
  const rows: Array<{ model: string; id: string; fields: null }> = [];
  const scopes: Array<{ model: string; scopeKey: string }> = [];
  const scopeChanges: Array<{ model: string; scopeKey: string; detachIds?: string[]; rebuild?: boolean }> = [];
  const report: GcReport = { evicted: {}, scopesRemoved: {} };
  const noteScopeRemoval = (host: GcHost, key: string): void => {
    report.scopesRemoved[host.modelId] = (report.scopesRemoved[host.modelId] ?? 0) + 1;
    maintainedModels.add(host.modelId);
    scopes.push({ model: host.modelId, scopeKey: key });
    scopeChanges.push({ model: host.modelId, scopeKey: key, rebuild: true });
  };
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

  const activeScopeDependencies = new Set(
    getCommitBus()
      .activeDependencies()
      .filter((dependency): dependency is Extract<typeof dependency, { kind: 'scope' }> => dependency.kind === 'scope')
      .map(dependency => `${dependency.model}\0${dependency.scopeKey}`)
  );
  const now = Date.now();
  for (const host of hosts.values()) {
    const threshold = host.idleScopeAfterMs?.();
    if (!host.exempt && threshold !== undefined) {
      for (const key of host.scopeKeys()) {
        if (activeScopeDependencies.has(`${host.modelId}\0${key}`)) continue;
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
  for (const dependency of getCommitBus().activeDependencies()) {
    if (dependency.kind === 'row') mark(dependency.model, dependency.id);
    if (dependency.kind === 'model') {
      const host = hosts.get(dependency.model);
      if (host) for (const id of host.rowIds()) mark(dependency.model, id);
    }
  }

  while (queue.length > 0) {
    const { model, id } = queue.shift() as { model: string; id: string };
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
        rows.push({ model: host.modelId, id, fields: null });
      }
    }
    if (evicted > 0) {
      report.evicted[host.modelId] = evicted;
      maintainedModels.add(host.modelId);
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
    getCommitBus().publish({ rows, scopes, mode: 'maintenance', scopeChanges, maintenanceModels: models });
  }

  flushPersistence();
  return report;
};
