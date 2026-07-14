export type Coverage = 'complete' | 'page' | 'delta';

export interface ScopeSpec<TStored> {
  by?: Record<string, keyof TStored & string>;
  sort?: { field: keyof TStored & string; dir: 'asc' | 'desc' } | { comparator: (a: TStored, b: TStored) => number } | 'server-order';
}

/** Declare a model scope without changing its specification. */
export const scope = <TStored>(spec: ScopeSpec<TStored>): ScopeSpec<TStored> => spec;
