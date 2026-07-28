import type { Dependency } from './core.apply.commitBus.types';

/** One `useLiveRead` engine cell: cached value, change version, and the deps that invalidate it. */
export type LiveReadState<T> = {
  value: T;
  version: number;
  signature: string;
  compute: () => T;
  isEqual: (a: T, b: T) => boolean;
  deps: ReadonlyArray<Dependency>;
};

/** Optional ordering for merged scope reads; without it extras append after the base rows. */
export type MergeOptions<TRow> = {
  comparator?: (left: TRow, right: TRow) => number;
};
