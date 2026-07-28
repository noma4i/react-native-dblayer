import type { QueryKey } from '@tanstack/react-query';

/** One mounted query/fetch reader registered for loss-driven refetch and foreground resume. */
export type ActiveFetchReader = {
  queryKey: QueryKey;
  /** Drop the reader's freshness when it is a foreground-resume candidate. */
  markResumeStale(): boolean;
  /** Refetch after the coordinator selected this reader's resume chunk. */
  refetch(): Promise<void>;
};

/** Query-invalidation callback registered per model. */
export type InvalidateFn = (scope?: unknown) => void;
