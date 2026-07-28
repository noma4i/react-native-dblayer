/** The scope snapshot shape retention hands back while a new key resolves. */
export type RetainedScopeSnapshot<T> = { rows: T[]; totalCount: number };

/** Hook-local retention cell: the last non-empty snapshot and the key it belongs to. */
export type RetentionState<T, TSnapshot extends RetainedScopeSnapshot<T>> = {
  generation: number;
  scopeKey: string | null;
  currentResolved: boolean;
  lastNonEmpty: TSnapshot | null;
};

export type KeepPreviousOption = {
  /** Retain the prior non-empty scope key until the current key produces its first resolved snapshot. Defaults to false. */
  keepPrevious?: boolean;
};
