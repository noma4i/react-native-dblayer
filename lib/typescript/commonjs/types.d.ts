import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import type { DocumentNode } from 'graphql';
import type { FieldSpec } from './schema/fieldSpec';
declare global {
  const __DEV__: boolean;
}
export type StorageAdapter = {
  /** Read a persisted value synchronously. */
  getItem(key: string): string | null;
  /** Write a persisted value synchronously. */
  setItem(key: string, value: string): void;
  /** Remove a persisted value synchronously. */
  removeItem(key: string): void;
  /** Enumerate stored keys under a prefix (hydration, GC and stale-key cleanup). */
  getAllKeys(): string[];
  /** Clear every key owned by the adapter. */
  clear(): void;
};
export type DbLogger = {
  /** Verbose lifecycle logs from request and mutation runtimes. */
  debug: (...args: unknown[]) => void;
  /** Errors observed by request and mutation runtimes. */
  error: (...args: unknown[]) => void;
};
/** GraphQL document accepted by the transport adapter. */
export type DbGraphQLDocument<TData = unknown, TVariables = Record<string, unknown>> = TypedDocumentNode<TData, TVariables> | DocumentNode;
type DbQueryOperation<TData = unknown, TVariables = Record<string, unknown>> = {
  /** GraphQL query document to execute. */
  query: DbGraphQLDocument<TData, TVariables>;
  /** Query variables passed to the transport. */
  variables?: TVariables;
} & Record<string, unknown>;
type DbMutationOperation<TData = unknown, TVariables = Record<string, unknown>> = {
  /** GraphQL mutation document to execute. */
  mutation: DbGraphQLDocument<TData, TVariables>;
  /** Mutation variables passed to the transport. */
  variables?: TVariables;
} & Record<string, unknown>;
type TransportResult<TData> = {
  /** Operation response data returned by the transport. */
  data: TData;
};
export type DbTransport = {
  /** Execute a GraphQL query and resolve to `{ data }`. */
  query: <TData = unknown, TVariables = Record<string, unknown>>(operation: DbQueryOperation<TData, TVariables>) => Promise<TransportResult<TData>>;
  /** Execute a GraphQL mutation and resolve to `{ data }`. */
  mutation: <TData = unknown, TVariables = Record<string, unknown>>(operation: DbMutationOperation<TData, TVariables>) => Promise<TransportResult<TData>>;
  /**
   * Subscribe to a GraphQL document and push response `data` objects to the provided callbacks.
   *
   * Implement this over the consumer GraphQL client's subscription primitive. Transport-level
   * reconnect and observer resubscription belong to the transport and are transparent to callers of
   * this seam.
   *
   * @param options GraphQL subscription document plus optional static variables.
   * @param handlers Callback pair for successful response data and transport/subscription errors.
   * @returns Unsubscribe callback for the active subscription.
   */
  subscribe?: (
    options: {
      query: DbGraphQLDocument;
      variables?: Record<string, unknown>;
    },
    handlers: {
      next: (data: unknown) => void;
      error: (error: unknown) => void;
    }
  ) => () => void;
};
export type ModelFieldSpecs = Record<string, FieldSpec<any, any, any, any>>;
export type DbWhere<T> =
  | Partial<T>
  | {
      and: Array<DbWhere<T>>;
    }
  | {
      or: Array<DbWhere<T>>;
    }
  | {
      not: DbWhere<T>;
    };
export interface DbReadOptions<T> {
  orderBy?: {
    field: keyof T & string;
    direction: 'asc' | 'desc';
  };
  limit?: number;
}
type StableProjectionBaseConfig<
  TSource,
  TEntry extends {
    item: TItem;
  },
  TItem
> = {
  /** Build a projection entry from source data. */
  buildEntry?: (source: TSource) => TEntry | null;
  /** Shared empty item array returned when no data is present. */
  emptyItems?: TItem[];
};
type StableProjectionKeyConfig<
  TSource,
  TEntry extends {
    item: TItem;
  },
  TItem
> =
  | (StableProjectionBaseConfig<TSource, TEntry, TItem> & {
      /** Stable key for a source value. */
      getKey: (source: TSource) => string;
    })
  | (TSource extends {
      id: string;
    }
      ? StableProjectionBaseConfig<TSource, TEntry, TItem> & {
          /** Omit to use the source item's string `id`. */
          getKey?: undefined;
        }
      : never);
export type StableProjectionConfig<
  TSource,
  TEntry extends {
    item: TItem;
  },
  TItem
> = StableProjectionKeyConfig<TSource, TEntry, TItem> & {
  /** Compare projection entries for stability. */
  entriesEqual: (prev: TEntry, next: TEntry) => boolean;
  /** Use `renderKeys` only with `useStableProjection`; not with custom entry equality. */
  renderKeys?: never;
};
type StableProjectionRenderKeysConfig<
  TSource,
  TEntry extends {
    item: TItem;
  },
  TItem extends object
> = StableProjectionKeyConfig<TSource, TEntry, TItem> & {
  /** Item fields that determine rendered equality. */
  renderKeys: Array<keyof TItem>;
  /** Custom entry equality is mutually exclusive with render key equality. */
  entriesEqual?: never;
};
export type StableItemsConfig<
  TSource,
  TEntry extends {
    item: TItem;
  },
  TItem extends object
> = StableProjectionConfig<TSource, TEntry, TItem> | StableProjectionRenderKeysConfig<TSource, TEntry, TItem>;
type StableEntityVolatileKeysConfig<TItem extends object> = {
  /** Fields ignored when comparing the current entity with the previous one. */
  volatileKeys: ReadonlyArray<keyof TItem & string>;
  renderKeys?: never;
};
type StableEntityRenderKeysConfig<TItem extends object> = {
  /** Fields that determine rendered equality. */
  renderKeys: ReadonlyArray<keyof TItem>;
  volatileKeys?: never;
};
export type StableEntityConfig<TItem extends object> = StableEntityVolatileKeysConfig<TItem> | StableEntityRenderKeysConfig<TItem>;
/** UI loading-state phase. */
export type LoadingPhase = 'idle' | 'hydrating' | 'initial_loading' | 'ready' | 'refreshing' | 'loading_more' | 'error';
/** UI state machine derived from query and collection state. */
export type LoadingState = {
  /** Current loading phase. */
  phase: LoadingPhase;
  /** Whether any data is available. */
  hasData: boolean;
  /** Whether the UI can show ready data. */
  isReady: boolean;
  /** Whether the initial skeleton should be visible. */
  showSkeleton: boolean;
  /** Whether primary data should be visible. */
  showData: boolean;
  /** Whether an empty state should be visible. */
  showEmptyState: boolean;
  /** Whether a pull/refresh indicator should be visible. */
  showRefreshIndicator: boolean;
  /** Whether a pagination footer spinner should be visible. */
  showFooterSpinner: boolean;
  /** Whether a non-blocking error banner should be visible. */
  showErrorBanner: boolean;
};
export type ComputePhaseInput = {
  /** Whether the owning screen is inactive. */
  isInactive?: boolean;
  /** Whether persisted data is hydrating. */
  isRestoring: boolean;
  /** Whether collection sync is ready. */
  isSyncReady: boolean;
  /** Whether a query request is in flight. */
  isFetching: boolean;
  /** Whether any data is available. */
  hasData: boolean;
  /** Whether a refresh is in flight. */
  isRefreshing: boolean;
  /** Whether a next-page request is in flight. */
  isFetchingNextPage: boolean;
  /** Whether the query is in an error state. */
  isError: boolean;
  /** Whether network data has been fetched at least once. */
  hasFetchedData: boolean;
};
export {};
//# sourceMappingURL=types.d.ts.map
