export type ScopeCoverage = 'complete' | 'page' | 'delta';

type ScopeEntry = { id: string; order: number; seq: number; edge?: Record<string, unknown> };

export type ScopeIndexValue = {
  generation: number;
  coverage: ScopeCoverage;
  entries: ScopeEntry[];
};
