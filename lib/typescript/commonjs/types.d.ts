import type { StorageEventApi } from '@tanstack/db';
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
    /** Enumerate stored keys for freshness pruning. */
    getAllKeys(): string[];
    /** Clear every key owned by the adapter. */
    clear(): void;
    /** Cross-context change events; a no-op implementation is valid on React Native. */
    eventApi: StorageEventApi;
};
export type DbLogger = {
    /** Verbose lifecycle logs from request and mutation runtimes. */
    debug: (...args: unknown[]) => void;
    /** Errors observed by request and mutation runtimes. */
    error: (...args: unknown[]) => void;
};
export type DbTrackEvent = {
    /** Analytics-agnostic event name. */
    name: string;
    /** Optional structured event payload. */
    payload?: Record<string, unknown>;
};
export type DbTrackSink = (event: DbTrackEvent) => void;
/** Domain-defined extract payload or preset. */
type DbExtractSpec = unknown;
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
    subscribe?: (options: {
        query: DbGraphQLDocument;
        variables?: Record<string, unknown>;
    }, handlers: {
        next: (data: unknown) => void;
        error: (error: unknown) => void;
    }) => () => void;
};
export type StoredRowBase = {
    id: string;
    updatedAt?: string | null;
};
export type StoredWriteInput<TStored> = TStored extends {
    readonly related: unknown;
} ? Omit<TStored, 'related'> : TStored;
export type DbModelDefaults = {
    merge?: {
        /**
         * Skip an identical merge batch within this window.
         * @default 0
         */
        dedupeWindowMs?: number;
    };
};
export interface CreatePatchCrudConfig<T extends {
    id: string;
}> {
    /** Target collection. */
    collection: {
        get(id: string): T | undefined;
        has(id: string): boolean;
        update(id: string, updater: (draft: T) => void): void;
        delete(id: string): void | boolean;
    };
}
export interface PatchCrud<T extends {
    id: string;
}> {
    /** Shallow-update a row by id. */
    patch(id: string, updates: Partial<T>): boolean;
    /** Delete a row by id. */
    destroy(id: string): boolean;
}
export type IncomingRecord = Record<string, unknown> & {
    updatedAt?: string | null;
};
export interface ShouldAcceptIncomingOptions<TExisting extends IncomingRecord, TIncoming extends IncomingRecord> {
    /** Timestamp comparison strategy. */
    timestampMode?: 'incoming-newer' | 'when-both-present';
    /** Equality strategy used before accepting an incoming row. */
    equalityMode?: 'full' | 'defined-fields';
    /** Force-accept an incoming row. */
    shouldOverwrite?: (existing: TExisting, incoming: TIncoming) => boolean;
}
/**
 * Public write contract for a server-data sync: write strategy, freshness label, and optional scope tag.
 * `source` is optional rather than the originally proposed required field - `mergeSyncContract`/
 * `replaceSyncContract` always set it, but some package-internal test call sites construct a bare
 * `{ mode: 'merge' }` literal directly against a model's `applyServerData` without it; making it
 * required would silently break those callers (see the P2a-fix report for the exact list).
 */
export interface SyncContract<TScope = unknown> {
    /** Write strategy: merge new data or replace the scoped set. */
    mode: 'merge' | 'replace';
    /** Freshness/debug label for this write. */
    source?: string;
    /** Optional opaque scope tag for scoped writes. */
    scope?: TScope;
    /** Collection version captured before the server transport starts. */
    snapshotSeq?: number;
}
export type CollectionFetchState = {
    /** Millisecond timestamp when the scope was marked fetched. */
    touchedAt: number;
    /** Whether the fetched scope was known empty. */
    empty: boolean;
    /** Last known pagination state for the fetched scope. */
    pageInfo?: PageInfo;
};
export type CollectionFetchScopeRecord = {
    /** Storage key suffix for the fetch-state scope; undefined is the root scope. */
    scopeKey?: string;
    /** Stored-row filter persisted with scoped fetch-state metadata. */
    scope?: Record<string, unknown>;
    /** Snapshot freshness state for this scope. */
    state: CollectionFetchState;
};
export interface FetchStateRemovalListener {
    /** Called when a freshness scope is removed. */
    (scopeKey?: string): void;
}
export type ModelFieldSpecs = Record<string, FieldSpec<any, any, any, any>>;
export type ModelMirrorTarget<TStored extends {
    id: string;
    updatedAt?: string | null;
}> = {
    get(id: string | undefined | null): TStored | undefined;
    patch(id: string, updates: Partial<TStored>): void;
    insertStored(item: TStored): void;
    collection: {
        readonly id: string;
    };
    buildStored?: (partial: any) => StoredWriteInput<TStored>;
};
export type ModelMirrorConfig<TSourceStored extends {
    id: string;
    updatedAt?: string | null;
}, TTargetStored extends {
    id: string;
    updatedAt?: string | null;
}> = {
    /** Lazy target model resolver; lazy resolution avoids circular model import timing. */
    model: () => ModelMirrorTarget<TTargetStored>;
    /**
     * Project a source row into same-id target writes.
     *
     * Mirrors run for local insert/patch/replaceRaw writes and for `applyServerData` writes. This differs
     * from relation touch, which remains local-only because server payloads already carry their own
     * `updatedAt`; mirror targets never receive the source model's server payload. Returning `null` skips
     * the target write. Undefined-valued projection keys are dropped before patch/insert, and writes made
     * by a mirror do not re-enter write propagation.
     */
    project: (row: TSourceStored) => Partial<TTargetStored> | null;
};
export type DbWhere<T> = Partial<T> | {
    and: Array<DbWhere<T>>;
} | {
    or: Array<DbWhere<T>>;
} | {
    not: DbWhere<T>;
};
export interface DbReadOptions<T> {
    orderBy?: {
        field: keyof T & string;
        direction: 'asc' | 'desc';
    };
    limit?: number;
}
type StableProjectionBaseConfig<TSource, TEntry extends {
    item: TItem;
}, TItem> = {
    /** Build a projection entry from source data. */
    buildEntry?: (source: TSource) => TEntry | null;
    /** Shared empty item array returned when no data is present. */
    emptyItems?: TItem[];
};
type StableProjectionKeyConfig<TSource, TEntry extends {
    item: TItem;
}, TItem> = (StableProjectionBaseConfig<TSource, TEntry, TItem> & {
    /** Stable key for a source value. */
    getKey: (source: TSource) => string;
}) | (TSource extends {
    id: string;
} ? StableProjectionBaseConfig<TSource, TEntry, TItem> & {
    /** Omit to use the source item's string `id`. */
    getKey?: undefined;
} : never);
export type StableProjectionConfig<TSource, TEntry extends {
    item: TItem;
}, TItem> = StableProjectionKeyConfig<TSource, TEntry, TItem> & {
    /** Compare projection entries for stability. */
    entriesEqual: (prev: TEntry, next: TEntry) => boolean;
    /** Use `renderKeys` only with `useStableItems`; not with custom entry equality. */
    renderKeys?: never;
};
type StableProjectionRenderKeysConfig<TSource, TEntry extends {
    item: TItem;
}, TItem extends object> = StableProjectionKeyConfig<TSource, TEntry, TItem> & {
    /** Item fields that determine rendered equality. */
    renderKeys: Array<keyof TItem>;
    /** Custom entry equality is mutually exclusive with render key equality. */
    entriesEqual?: never;
};
export type StableItemsConfig<TSource, TEntry extends {
    item: TItem;
}, TItem extends object> = StableProjectionConfig<TSource, TEntry, TItem> | StableProjectionRenderKeysConfig<TSource, TEntry, TItem>;
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
export type PageInfo = {
    /** Whether another page is available after the current page. */
    hasNextPage: boolean;
    /** Whether another page is available before the current page. */
    hasPreviousPage: boolean;
    /** Cursor of the first item in the page. */
    startCursor?: string | null;
    /** Cursor of the last item in the page. */
    endCursor?: string | null;
};
type PageInfoInput = {
    /** Optional raw next-page flag from a connection. */
    hasNextPage?: boolean | null;
    /** Optional raw previous-page flag from a connection. */
    hasPreviousPage?: boolean | null;
    /** Optional raw start cursor from a connection. */
    startCursor?: string | null;
    /** Optional raw end cursor from a connection. */
    endCursor?: string | null;
};
/** Normalized nodes and pagination metadata from a connection. */
export type ConnectionResult<TNode> = {
    nodes: TNode[];
    pageInfo: PageInfo;
};
export type ConnectionWithNodes = {
    /** Connection nodes. */
    nodes?: Array<unknown> | null;
    /** Connection pagination metadata. */
    pageInfo?: PageInfoInput | null;
};
export type ConnectionWithEdges = {
    /** Connection edges containing nodes. */
    edges?: Array<{
        node?: unknown;
    } | null | undefined> | null;
    /** Connection pagination metadata. */
    pageInfo?: PageInfoInput | null;
};
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
type DbMutationSharedConfig<TData, TInput, TContext, TExtractSpec = DbExtractSpec> = {
    /** GraphQL mutation document. */
    mutation: DbGraphQLDocument<Record<string, TData>, {
        input: unknown;
    }>;
    /** Response data field that contains the mutation result. */
    resultField: string;
    /** Transform caller input into `variables.input`. */
    mapInput?: (input: TInput) => unknown;
    /** Key factory used for React Query. */
    key?: () => readonly unknown[];
    /**
     * Opt-in transport dedupe. When provided, concurrent mutation calls whose `key(input)` serialize to
     * the same non-null string share one in-flight transport promise. Omitted (default) - every call is
     * an independent transport: identical payloads are NOT deduped (v4 behavior change; v3 deduped by
     * mutationKey + mapped input, which silently swallowed legitimate identical sends).
     */
    dedupe?: {
        key: (input: TInput) => string | null;
    };
    /** Log tag for mutation lifecycle messages. */
    logPrefix?: string;
    /** Side-load spec resolved through the mutation extract seam. */
    extract?: TExtractSpec;
    /** Source label passed to the extract sink; defaults to `mutation`. */
    extractSource?: string;
    /** Server write-through that runs inside the transaction after the response. */
    onCommit?: (data: TData | null, input: TInput, context: TContext) => void;
    /** Post-commit invalidation hook. */
    invalidate?: (data: TData | null, input: TInput) => void;
    /** Failure hook called after hook-path rollback and before the original error is rethrown. */
    onError?: (error: Error, input: TInput, context: TContext) => void;
    /** Declarative analytics-agnostic mutation tracking. */
    track?: {
        /** Event emitted before the optimistic/onMutate phase. */
        start?: (input: TInput) => DbTrackEvent | null | undefined;
        /** Event emitted after extract, preset commit, and manual onCommit. */
        success?: (data: TData | null, input: TInput, context: TContext) => DbTrackEvent | null | undefined;
        /** Event emitted in the error path after onError and before rethrow. */
        error?: (error: Error, input: TInput) => DbTrackEvent | null | undefined;
    };
};
type DbOptimisticMutationContext<TStored = unknown> = {
    /** Optimistic row id generated by the preset, or an existing retry temp id. */
    tempId: string | null;
    /** Stored optimistic row inserted by the preset or read from an existing retry temp id. */
    optimisticRow: TStored | null;
};
type DbMutationContextWithOptimistic<TContext, TStored> = [TContext] extends [void] ? DbOptimisticMutationContext<TStored> : TContext & DbOptimisticMutationContext<TStored>;
type DbMutationPreserveOnCommitConfig<TStored, TServerNode> = ((serverNode: TServerNode, context: DbOptimisticMutationContext<TStored>) => TServerNode) | {
    fields: Array<keyof (TStored & TServerNode)>;
    mergers?: Partial<Record<keyof (TStored & TServerNode), (optimisticValue: unknown, serverValue: unknown) => unknown>>;
};
type DbMutationOptimisticConfig<TData, TInput, TStored, TServerNode = unknown> = {
    /** Model receiving the optimistic row and the committed server node. */
    model: {
        get: (id: string | undefined | null) => TStored | undefined;
        insertStored: (item: TStored) => void;
        replaceRaw: (oldId: string, item: TServerNode) => boolean;
        applyServerData: (items: TServerNode[], contract: SyncContract) => unknown;
    };
    /** Prefix passed to `generateTempId`; omit for the default `temp-*` ids. */
    tempIdPrefix?: string;
    /** Select an already-created optimistic id for retry/upload flows; defaults to `input.tempId`. */
    selectTempId?: (input: TInput) => string | null | undefined;
    /** Build the stored optimistic row. Return null to skip insertion and commit via `applyServerData`. */
    buildStored: (params: {
        input: TInput;
        tempId: string;
    }) => TStored | null | undefined;
    /** Select the server node that replaces or merges the optimistic row. */
    selectServerNode: (data: TData | null, input: TInput) => TServerNode | null | undefined;
    /** Preserve optimistic snapshot fields before server commit writes the selected node. */
    preserveOnCommit?: DbMutationPreserveOnCommitConfig<TStored, TServerNode>;
};
type DestroyModelAdapter = {
    /** Delete a row by id. */
    destroy: (id: string) => boolean;
};
type PatchModelAdapter<TData = unknown> = {
    /** Snapshot read by id before building an optimistic patch. */
    get: (id: string) => TData | undefined;
    /** Shallow-update a row by id. */
    patch: (id: string, updates: Record<string, unknown>) => boolean;
};
type DbMutationDefaultConfig<TData, TInput, TContext, TExtractSpec = DbExtractSpec> = DbMutationSharedConfig<TData, TInput, TContext, TExtractSpec> & {
    /** Custom optimistic variant; leave undefined. */
    method?: undefined;
    optimistic?: never;
    /** Optimistic write; returns context passed to commit/error hooks. */
    onMutate?: (input: TInput) => TContext;
    model?: never;
    selectId?: never;
    selectPatch?: never;
};
type DbMutationOptimisticDefaultConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec = DbExtractSpec> = DbMutationSharedConfig<TData, TInput, DbMutationContextWithOptimistic<TContext, TStored>, TExtractSpec> & {
    /** Custom optimistic variant; leave undefined. */
    method?: undefined;
    /** Declarative optimistic row preset. */
    optimistic: DbMutationOptimisticConfig<TData, TInput, TStored, TServerNode>;
    /** Optional extra optimistic side effects; object returns are merged into the commit context. */
    onMutate?: (input: TInput) => TContext | void;
    model?: never;
    selectId?: never;
    selectPatch?: never;
};
type DbMutationDestroyConfig<TData, TInput, TContext, TExtractSpec = DbExtractSpec> = DbMutationSharedConfig<TData, TInput, TContext, TExtractSpec> & {
    /** Declarative optimistic delete variant. */
    method: 'destroy';
    /** Model to delete from. */
    model: DestroyModelAdapter;
    /** Select the row id to delete from caller input. */
    selectId: (input: TInput) => string | null | undefined;
    optimistic?: never;
    onMutate?: never;
    selectPatch?: never;
};
type DbMutationPatchConfig<TData, TInput, TContext, TStored, TExtractSpec = DbExtractSpec> = DbMutationSharedConfig<TData, TInput, TContext, TExtractSpec> & {
    /** Declarative optimistic patch variant. */
    method: 'patch';
    /** Model to patch. */
    model: PatchModelAdapter<TStored>;
    /** Select the row id to patch from caller input. */
    selectId: (input: TInput) => string | null | undefined;
    /** Build the optimistic patch from input and the current row. */
    selectPatch: (input: TInput, current?: TStored) => Record<string, unknown> | null | undefined;
    optimistic?: never;
    onMutate?: never;
};
/**
 * Transactional GraphQL mutation config with custom, patch, or destroy optimistic variants.
 *
 * `TExtractSpec` narrows the `extract` property for preset-table key and selector checks. It defaults
 * to the untyped extract seam so existing configs compile unchanged.
 */
export type DbMutationConfig<TData, TInput, TContext = void, TStored = unknown, TServerNode = unknown, TExtractSpec = DbExtractSpec> = DbMutationDefaultConfig<TData, TInput, TContext, TExtractSpec> | DbMutationOptimisticDefaultConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec> | DbMutationDestroyConfig<TData, TInput, TContext, TExtractSpec> | DbMutationPatchConfig<TData, TInput, TContext, TStored, TExtractSpec>;
export type DbCommandConfig<TData, TInput> = {
    /** Command key factory used for React Query. */
    key?: () => readonly unknown[];
    /** Log tag for command lifecycle messages. */
    logPrefix?: string;
    /** Execute the command with caller input. */
    mutationFn: (input: TInput) => Promise<TData>;
    /** Opt-in transport dedupe for concurrent commands with the same non-null key. */
    dedupe?: {
        key: (input: TInput) => string | null;
    };
    /** Success callback. */
    onSuccess?: (data: TData, input: TInput) => void;
    /** Error callback. */
    onError?: (error: unknown, input: TInput) => void;
    /** Settled callback. */
    onSettled?: () => void;
};
type DbCommandMutationBase<TInput, TData, TExtractSpec = DbExtractSpec> = {
    /** Command key factory used for React Query. */
    key?: () => readonly unknown[];
    /** Log tag for command lifecycle messages. */
    logPrefix?: string;
    /** Opt-in transport dedupe for concurrent commands with the same non-null key. */
    dedupe?: {
        key: (input: TInput) => string | null;
    };
    /** Side-load spec resolved through the mutation extract seam after the transport response. */
    extract?: TExtractSpec;
    /** Source label passed to the extract sink; defaults to `mutation`. */
    extractSource?: string;
    /** Declarative analytics-agnostic command tracking. */
    track?: {
        /** Event emitted before the transport request. */
        start?: (input: TInput) => DbTrackEvent | null | undefined;
        /** Event emitted after extract handling. */
        success?: (data: TData | null, input: TInput) => DbTrackEvent | null | undefined;
        /** Event emitted before rethrow when the command fails. */
        error?: (error: Error, input: TInput) => DbTrackEvent | null | undefined;
    };
};
type DbCommandStaticConfig<TInput, TData, TExtractSpec = DbExtractSpec> = DbCommandMutationBase<TInput, TData, TExtractSpec> & {
    /** Static GraphQL mutation document. */
    mutation: DbGraphQLDocument<Record<string, TData>, {
        input: unknown;
    }>;
    /** Response data field returned by the command. */
    resultField: string;
    /** Transform caller input into `variables.input`. */
    mapInput?: (input: TInput) => unknown;
    resolve?: never;
};
type DbCommandResolvedConfig<TInput, TData, TExtractSpec = DbExtractSpec> = DbCommandMutationBase<TInput, TData, TExtractSpec> & {
    mutation?: never;
    resultField?: never;
    mapInput?: never;
    /** Resolve the operation per input instead of using static fields. */
    resolve: (input: TInput) => {
        /** GraphQL mutation document for this input. */
        mutation: DbGraphQLDocument<Record<string, TData>, {
            input: unknown;
        }>;
        /** Response data field returned by this operation. */
        resultField: string;
        /** Optional already-mapped input for `variables.input`. */
        input?: unknown;
    };
};
/**
 * Fire-and-forget GraphQL command config, either static or resolved per input.
 *
 * `TExtractSpec` narrows the command `extract` property and defaults to the untyped extract seam.
 */
export type DbCommandMutationConfig<TInput, TData = unknown, TExtractSpec = DbExtractSpec> = DbCommandStaticConfig<TInput, TData, TExtractSpec> | DbCommandResolvedConfig<TInput, TData, TExtractSpec>;
export {};
//# sourceMappingURL=types.d.ts.map