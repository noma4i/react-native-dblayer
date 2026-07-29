import type { StoragePlane, ScopeEntry, ScopeIndex, ScopeIndexValue } from '../../types';
export declare const isScopeEntry: (value: unknown) => value is ScopeEntry;
/** Deduplicate scope entries by id before planning or apply; the last payload occurrence supplies the retained value. */
export declare const deduplicateScopeEntriesById: <
  T extends {
    id: string;
  }
>(
  entries: readonly T[]
) => T[];
/** Validate one unordered scope-entry set: every entry is valid and both member ids and order keys are unique. */
export declare const isScopeEntrySet: (value: unknown) => value is ScopeEntry[];
export declare const isScopeIndexValue: (value: unknown) => value is ScopeIndexValue;
export declare const createScopeIndex: (options: { modelId: string; scopeNames?: string[]; storage: StoragePlane; prefix: () => string }) => ScopeIndex;
//# sourceMappingURL=scopeIndex.d.ts.map
