export type Coverage = 'complete' | 'page' | 'delta';

export type ScopeEntry = { id: string; order: number; seq: number; edge?: Record<string, unknown> };

export type ScopeIndexValue = { generation: number; coverage: Coverage; entries: ScopeEntry[] };

export type ScopeIndex = {
  read(key: string): ScopeIndexValue;
  write(key: string, next: ScopeIndexValue): void;
  reconcile(key: string, coverage: Coverage, ids: string[]): ScopeIndexValue;
  reset(): void;
};

export const createScopeIndex = (): ScopeIndex => {
  const scopes = new Map<string, ScopeIndexValue>();
  const empty = (): ScopeIndexValue => ({ generation: 0, coverage: 'delta', entries: [] });

  return {
    read: key => scopes.get(key) ?? empty(),
    write: (key, next) => {
      scopes.set(key, next);
    },
    reconcile: (key, coverage, ids) => {
      const previous = scopes.get(key) ?? empty();
      const entries = coverage === 'complete'
        ? ids.map((id, order) => ({ id, order, seq: previous.generation + 1 }))
        : previous.entries;
      const next = { generation: previous.generation + 1, coverage, entries };
      scopes.set(key, next);
      return next;
    },
    reset: () => scopes.clear()
  };
};
