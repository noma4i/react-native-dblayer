import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import type { DocumentNode } from 'graphql';
import type { FieldSpec } from './schema.fieldSpec.types';
import type { ReadOrder } from './dsl.ordering.types';
/** Generic stored row: an id plus arbitrary model fields - the shared shape behind every untyped row seam. */
export type RowRecord = {
    id: string;
} & Record<string, unknown>;
export type StorageAdapter = {
    /** Read a persisted value synchronously. */
    getItem(key: string): string | null;
    /** Write a persisted value synchronously. */
    setItem(key: string, value: string): void;
    /** Remove a persisted value synchronously. */
    removeItem(key: string): void;
    /** Enumerate stored keys under a prefix (hydration, GC and stale-key cleanup). */
    allKeys(): string[];
};
export type DbLogger = {
    /** Verbose lifecycle logs from request and mutation runtimes. */
    debug: (...args: unknown[]) => void;
    /** Errors observed by request and mutation runtimes. */
    error: (...args: unknown[]) => void;
};
export type DbRetryClass = 'network' | 'server' | 'retriable' | 'fatal';
export type DbRetryPolicy = {
    /** Classify one failure before its retry budget is consulted. Omit for no retries. */
    classify?: (error: unknown) => DbRetryClass;
    /** Maximum retry attempts for each non-fatal class. Defaults to zero. */
    budgets?: Partial<Record<Exclude<DbRetryClass, 'fatal'>, number>>;
    /** Exponential retry delay bounds in milliseconds. Defaults to 1000 and 30000. */
    backoff?: {
        baseMs: number;
        maxMs: number;
    };
};
/** GraphQL document accepted by the transport adapter. */
export type DbGraphQLDocument<TData = unknown, TVariables = never> = TypedDocumentNode<TData, TVariables> | DocumentNode;
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
/** One GraphQL error returned in a resolved transport response. */
export type DbTransportError = {
    message: string;
    path?: readonly (string | number)[];
    extensions?: Record<string, unknown>;
};
type TransportResult<TData> = {
    /** Operation response data returned by the transport. */
    data: TData;
    /** GraphQL response errors, including partial responses with non-empty `data`. Absence means no errors, not an unknown status. */
    errors?: readonly DbTransportError[];
};
export type DbTransport = {
    /** Execute a GraphQL query and resolve to `{ data, errors? }`; GraphQL errors must be populated even when partial data is present. */
    query: <TData = unknown, TVariables = Record<string, unknown>>(operation: DbQueryOperation<TData, TVariables>) => Promise<TransportResult<TData>>;
    /** Execute a GraphQL mutation and resolve to `{ data, errors? }`; GraphQL errors must be populated even when partial data is present. */
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
    subscribe?: (options: {
        query: DbGraphQLDocument;
        variables?: Record<string, unknown>;
    }, handlers: {
        next: (data: unknown) => void;
        error: (error: unknown) => void;
    }) => () => void;
};
export type ModelFieldSpecs = Record<string, FieldSpec<any, any, any, any>>;
/**
 * Comparison operators accepted in a `DbWhere` leaf value. All operators are LOCAL predicates over
 * already-stored rows: ordering operators (`gt`/`gte`/`lt`/`lte`) compare numbers numerically and
 * strings by codepoint (ISO date strings therefore compare chronologically); `in`/`notIn` use strict
 * equality against the operand list, and a row holding no value belongs to no list.
 * Mixed-type or nullish row values never match an ordering operator.
 */
export type DbWhereOp<V> = {
    gt?: V;
    gte?: V;
    lt?: V;
    lte?: V;
    in?: readonly V[];
    notIn?: readonly V[];
};
type DbWhereLeaf<T> = {
    [K in keyof T]?: T[K] | DbWhereOp<NonNullable<T[K]>>;
};
export type DbWhere<T> = DbWhereLeaf<T> | {
    and: Array<DbWhere<T>>;
} | {
    or: Array<DbWhere<T>>;
} | {
    not: DbWhere<T>;
};
export interface DbReadOptions<T> {
    orderBy?: ReadOrder<T>;
    limit?: number;
}
/** UI loading-state phase. */
export type LoadingPhase = 'idle' | 'initial_loading' | 'ready' | 'refreshing' | 'loading_more' | 'error';
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
    /** Whether an automatic retry attempt is currently in flight (failureCount > 0 and fetching). */
    isRetrying: boolean;
    /** Number of consecutive failed fetch attempts for the current request (react-query failureCount). */
    retryAttempt: number;
    /** Whether the request is paused because the device is offline (react-query fetchStatus === 'paused'). */
    isOffline: boolean;
};
export type ComputePhaseInput = {
    /** Whether the owning screen is inactive. */
    isInactive?: boolean;
    /** Whether a query request is in flight. */
    isFetching: boolean;
    /** Whether the query's previously-committed destination rows have died locally (destroy/GC/trim) and a refetch is imminent - distinct from a genuinely empty completed fetch. */
    committedRowsDied: boolean;
    /** Whether the request is paused (offline): react-query fetchStatus === 'paused'. */
    isPaused: boolean;
    /** Consecutive failed attempts for the current request: react-query failureCount. */
    retryAttempt: number;
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
/** Boolean composition operators accepted anywhere a `DbWhere` is accepted. */
export type DbWhereOperator<T> = {
    and: Array<DbWhere<T>>;
} | {
    or: Array<DbWhere<T>>;
} | {
    not: DbWhere<T>;
};
/** Result of `pickPresent`: the chosen keys with nullish values dropped from the type. */
export type PresentPick<TSource extends object, TKey extends keyof TSource> = Partial<{
    [K in TKey]: NonNullable<TSource[K]>;
}>;
export {};
//# sourceMappingURL=db.types.d.ts.map