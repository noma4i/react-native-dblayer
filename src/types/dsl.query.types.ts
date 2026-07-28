import type { DbReadOptions, LoadingState } from './db.types';

export type PlanRowsSink = { modelId: string };

export type ExtractSink = { into: PlanRowsSink; rows: unknown[] };

export type QueryResult<T> = {
  data: T[] | T | undefined; loadingState: LoadingState; error: Error | null; hasNextPage: boolean;
  isFetchingNextPage: boolean; fetchNextPage: () => void; refetch: () => Promise<void>;
};

export type EnsuredRowResult<TStored> = {
  row: TStored | undefined; loadingState: LoadingState; error: Error | null; refetch: () => Promise<void>;
};

export type QueryHandle<TStored, TScope> = {
  use(scope: TScope | null, options?: { enabled?: boolean }): QueryResult<TStored>; fetch(scope: TScope | null): Promise<void>; invalidate(scope?: TScope): void;
};

export type EnsuredRowQueryHandle<TStored, TScope> = QueryHandle<TStored, TScope> & {
  useRowEnsured(scope: TScope, rowId: string | null | undefined, readOpts?: DbReadOptions<TStored> & { renderKeys?: readonly (keyof TStored & string)[] }): EnsuredRowResult<TStored>;
};
