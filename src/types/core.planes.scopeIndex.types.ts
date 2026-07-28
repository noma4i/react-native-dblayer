/** Scope coverage mode used by scope membership reconciliation. */
export type ScopeCoverage = 'complete' | 'page' | 'delta';

type ScopeEntry = { id: string; order: number; seq: number; edge?: Record<string, unknown> };

/** Persisted scope index snapshot used by the membership ledger. */
export type ScopeIndexValue = {
  generation: number;
  coverage: ScopeCoverage;
  entries: ScopeEntry[];
};
