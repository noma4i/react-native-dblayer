import type { DbReadOptions, DbWhere, ModelFieldSpecs } from '../types';
import type { JournalOp } from '../core/apply/journal';
import { type RelationDecl } from '../core/relations';
import { defineFetch } from './defineFetch';
import { defineMutation, type MutationConfig } from './defineMutation';
import { defineQuery } from './defineQuery';
import { type ViewConfig, type ViewHandle } from './defineView';
import { type ModelIngestEntry } from './defineIngest';
import type { DbSubscriptionEntry } from '../core/subscriptionRuntime';
import type { Coverage, ScopeSpec } from './scope';
export type ScopeValueOf<TScope> = TScope extends ScopeSpec<infer _TStored> ? Record<string, unknown> : never;
type ModelQueryConfig<TResponse, TVars, TScope, TStored> = Omit<Parameters<typeof defineQuery<TResponse, TVars, TScope, TStored>>[0], 'key' | 'into'> & {
    key?: string;
    into?: Parameters<typeof defineQuery<TResponse, TVars, TScope, TStored>>[0]['into'];
};
type ModelMutationConfig<TData, TInput, TStored extends {
    id: string;
}, TNode> = Omit<MutationConfig<TData, TInput, TStored, TNode>, 'dedupe'> & {
    dedupe?: false | MutationConfig<TData, TInput, TStored, TNode>['dedupe'];
};
type ModelFetchConfig<TData, TInput, TSelected> = Omit<Parameters<typeof defineFetch<TData, TInput, TSelected>>[0], 'key'> & {
    key?: string;
};
/**
 * Reactive access to one named scope of a model (`model.scopes.<name>`), backed by the scope's
 * membership index. `scopeValue` selects the concrete scope instance (e.g. `{ chatId }`); `null`/`undefined`
 * reads as empty without subscribing.
 */
export type ScopeHandle<TStored extends {
    id: string;
}, TScope> = {
    modelId: string;
    /** Reactive read of every row currently in the scope, in the scope's configured sort order. */
    use(scopeValue: TScope | null | undefined): TStored[];
    /**
     * Reactive, render-windowed read of the scope: renders only the first `pageSize` (default from
     * `configureDb`'s `defaults.pageSize`, else 20) rows locally, growing the window on demand via the
     * returned `fetchNextPage`. This is LOCAL window growth over rows already synced into the model - a
     * different concept from `QueryResult.fetchNextPage` (`defineQuery`'s network pagination, which fetches
     * another page from the server), even though both surfaces share the `fetchNextPage` name. A list
     * typically wires both: `QueryResult.hasNextPage` / `QueryResult.fetchNextPage()` to fetch more rows
     * from the network, and `useWindow(...).hasMore` / `useWindow(...).fetchNextPage()` to reveal more of
     * what is already local. The window resets to `pageSize` whenever `scopeValue`'s key changes.
     */
    useWindow(scopeValue: TScope | null | undefined, opts?: {
        pageSize?: number;
    }): {
        /** The current window: the first `totalCount` rows up to the window size. */
        rows: TStored[];
        /** Total rows currently in the scope, independent of the window size. */
        totalCount: number;
        /** `true` while `totalCount` exceeds the current window size. */
        hasMore: boolean;
        /** Grow the local window by `pageSize` more rows. Does not touch the network. */
        fetchNextPage: () => void;
    };
    /** Reactive count of rows currently in the scope. */
    useCount(scopeValue: TScope | null | undefined): number;
    /** Clear this scope's fetch-state and invalidate its derived React Query key(s). */
    invalidate(scopeValue?: TScope): void;
    /** Synchronous snapshot read of the scope's rows, in sort order; safe to call outside React. */
    read(scopeValue: TScope): TStored[];
    __apply?(scopeValue: TScope, rows: TStored[], coverage: Coverage, opts?: {
        resetOrder?: boolean;
    }): void;
    __planApply?(scopeValue: TScope, rows: Array<{
        row: TStored;
        edge?: Record<string, unknown>;
    }>, coverage: Coverage, opts?: {
        resetOrder?: boolean;
    }): JournalOp[];
    __key?(scopeValue: TScope): string;
};
export type ModelCore<TStored extends {
    id: string;
    updatedAt?: string | null;
}> = {
    modelId: string;
    /** Define a model-owned query with a conventional `<modelId>:<name>` key and this model as the default destination. */
    query<TResponse, TVars, TScope, TRow extends {
        id: string;
    }>(name: string, config: ModelQueryConfig<TResponse, TVars, TScope, TRow>): ReturnType<typeof defineQuery<TResponse, TVars, TScope, TRow>>;
    /** Define a model-owned mutation with conventional input-sensitive deduplication; pass `dedupe: false` to opt out. */
    mutation<TData, TInput, TRow extends {
        id: string;
    }, TNode>(name: string, config: ModelMutationConfig<TData, TInput, TRow, TNode>): ReturnType<typeof defineMutation<TData, TInput, TRow, TNode>>;
    /** Define an ephemeral model-namespaced fetch with a conventional `<modelId>:<name>` key. */
    fetch<TData, TInput = void, TSelected = TData>(name: string, config: ModelFetchConfig<TData, TInput, TSelected>): ReturnType<typeof defineFetch<TData, TInput, TSelected>>;
    /** Define a reactive joined projection over one declared scope and its current related rows. */
    view<TItem = TStored & Record<string, unknown>>(name: string, config: ViewConfig<TItem>): ViewHandle<TItem, Record<string, unknown>>;
    /** Define model-owned subscription entries that apply rows, guards, effects, and custom handlers together. */
    ingest(entries: Record<string, ModelIngestEntry>): DbSubscriptionEntry[];
    get(id: string | null | undefined): TStored | undefined;
    getWhere(where: DbWhere<TStored>, opts?: DbReadOptions<TStored>): TStored[];
    /** Full snapshot - library/maintenance channel; app code stays on scoped reads. */
    getAll(): TStored[];
    patch(id: string, patch: Partial<TStored>): void;
    destroy(id: string): void;
    destroyMany(ids: string[]): void;
    insertStored(row: TStored): void;
    /**
     * Insert several rows as ONE plan: one journal record, one apply transaction, one commit publish -
     * unlike calling `insertStored` in a loop, which would journal/publish once per row. Each row still
     * goes through the same per-row normalize, `guard`, and event-origin tombstone gate as `insertStored`;
     * relation side effects (`touch`, `counterCache`, declarative scope membership) are expanded once over
     * the whole batch, so a `belongsTo` `counterCache` increments by the batch's full count in one step
     * rather than one increment per row.
     */
    insertStoredMany(rows: TStored[]): void;
    replaceRaw(oldId: string, next: unknown): void;
    buildStored(input: unknown): TStored;
    normalize(input: unknown): Partial<TStored> & {
        id: string;
    };
    invalidate(scope?: unknown): void;
    use: {
        row(id: string | null | undefined, opts?: {
            select?: ReadonlyArray<keyof TStored>;
        }): TStored | undefined;
        field<K extends keyof TStored>(id: string | null | undefined, field: K): TStored[K] | undefined;
        first(where?: DbWhere<TStored> | null, opts?: DbReadOptions<TStored>): TStored | undefined;
        where(where: DbWhere<TStored> | null, opts?: DbReadOptions<TStored>): TStored[];
        byIds(ids: string[]): TStored[];
        count(where?: DbWhere<TStored> | null): number;
        related(id: string | null | undefined, relation: string): unknown;
    };
    scopes: Record<string, ScopeHandle<TStored, Record<string, unknown>>>;
    registerReset(fn: () => void): void;
    __applyRows?(rows: TStored[]): void;
    __planRows?(rows: TStored[]): JournalOp[];
    __planReplace?(oldId: string, next: unknown): JournalOp[];
    __captureMembership?(id: string): Array<{
        id: string;
        scopeKey: string;
        order: number;
        edge?: Record<string, unknown>;
    }>;
    __planRestore?(next: unknown, memberships: Array<{
        id: string;
        scopeKey: string;
        order: number;
        edge?: Record<string, unknown>;
    }>): JournalOp[];
    __relations?(): Record<string, RelationDecl>;
};
type ModelConfig<TFields extends ModelFieldSpecs, TScopes extends Record<string, ScopeSpec<any>>, TExt extends Record<string, unknown>> = {
    /** Unique model id. Namespaces storage keys, dependency tracking, and cross-model relation targets. */
    id: string;
    /** Human-readable model name; prefixes normalize/apply error and log messages. */
    name: string;
    /** Field spec map (built with `f.*`) that drives normalize/build reads for every stored field. */
    fields: TFields;
    /**
     * Derive the row id from raw input. Defaults to `input.id`. Must return a non-empty string;
     * returning anything else makes `normalize` throw `${name} requires id` for that input, which
     * plan-building paths (writes, apply) catch and log as a rejected row, and direct `buildStored`/
     * `normalize` calls propagate to the caller.
     */
    rowId?: (input: unknown) => string;
    /**
     * Row-level filter run before id resolution. Return `false` to reject the input; `normalize` then
     * throws `${name} rejected input`, handled the same way as an unresolved `rowId` (see above).
     */
    guard?: (input: unknown) => boolean;
    /**
     * Lazily-evaluated relation declarations built with `belongsTo`/`hasMany`/`hasOne`/`references`.
     * Evaluated once on first access and cached, so relation targets that reference other models defined
     * later in the same module do not need to exist yet at `defineModel` call time.
     */
    relations?: () => Record<string, RelationDecl>;
    /**
     * Named `ScopeSpec` definitions (built with `scope(...)`). Each entry becomes a `model.scopes.<name>`
     * handle exposing scoped `use`/`useWindow`/`useCount`/`invalidate`/`read` and, for scopes with `by`,
     * automatic membership tracking as rows are written.
     */
    scopes?: TScopes;
    /** Set to `'exempt'` to keep this model's rows out of garbage-collection sweeps even when unreferenced. */
    gc?: 'exempt';
    merge?: {
        /**
         * Acceptance gate for an incoming write when a row with the same id already exists. Return `false`
         * to keep the existing row and drop the incoming one (e.g. an out-of-order or stale server echo).
         * Omit to always accept incoming writes.
         */
        shouldOverwrite?: (existing: unknown, incoming: unknown) => boolean;
    };
    /**
     * Build extra static members merged onto the returned model (e.g. singleton statics, custom finders).
     * Receives the base `ModelCore` so statics can call back into `get`/`patch`/`use`/etc. Throws at
     * `defineModel` time if any returned key collides with a base model key.
     */
    statics?: (model: ModelCore<any>) => TExt;
};
/**
 * Define a persistent, reactive collection model backed by `EntityState` and the shared journalled
 * apply pipeline. State planes (entity rows and scope membership) are created and hydrated from storage
 * lazily on first touch, so models can be declared at module scope before `configureDb` runs.
 *
 * @param config Field specs, id/guard resolution, optional relations/scopes, gc/merge policy, and statics.
 * @returns A `ModelCore` (snapshot reads, `use.*` reactive reads, `patch`/`destroy`/`insertStored`, `related`)
 * plus a `scopes` map of `ScopeHandle`s (one per configured scope) and any `statics` the config builds.
 */
export declare const defineModel: <TFields extends ModelFieldSpecs, TScopes extends Record<string, ScopeSpec<any>> = {}, TExt extends Record<string, unknown> = {}>(config: ModelConfig<TFields, TScopes, TExt>) => ModelCore<any> & {
    scopes: { [K in keyof TScopes]: ScopeHandle<any, ScopeValueOf<TScopes[K]>>; };
} & TExt;
export {};
//# sourceMappingURL=defineModel.d.ts.map