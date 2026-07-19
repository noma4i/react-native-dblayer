import type { DbGraphQLDocument, DbReadOptions, DbWhere, ModelFieldSpecs } from '../types';
import type { JournalOp } from '../core/apply/journal';
import { type RelationDecl } from '../core/relations';
import type { KeepPreviousOption } from '../read/scopeRetention';
import { defineFetch } from './defineFetch';
import { defineMutation, type MutationConfig } from './defineMutation';
import { defineQuery } from './defineQuery';
import { type ViewConfig, type ViewHandle } from './defineView';
import { type ModelIngestEntry } from './defineIngest';
import type { DbSubscriptionEntry } from '../core/subscriptionRuntime';
import { type ModelReadBuilder } from './readBuilder';
import type { RequiredFields } from './readBuilder';
import type { ScopeCoverage, ScopeSpec } from './scope';
import type { InferStoredFields } from '../schema/infer';
import { type ModelStatusPoller } from '../utils/modelStatusPoller';
export type ScopeValueOf<TScope> = TScope extends ScopeSpec<infer _TStored> ? Record<string, unknown> : never;
type ScopeWindowResult<T> = {
    /** Current-key rows, or retained previous-key rows while `isPreviousData` is true. */
    rows: T[];
    /** Total count for the snapshot represented by `rows`. */
    totalCount: number;
    /** Whether more locally-synced rows exist beyond the current window. */
    hasMore: boolean;
    /** Grow the local window by one page without fetching from the network. */
    fetchNextPage: () => void;
    /** True only while rows belong to the previous scope key and the current key is unresolved. */
    isPreviousData: boolean;
};
/** Manual injection surface for a query's colocated live entries. */
export type LiveQueryHandle = {
    /** Inject a payload into the same guarded pipeline transport events use for this query's live entries. */
    apply(event: string, payload: unknown): void;
};
type ModelQueryConfig<TResponse, TVars, TScope, TStored> = Omit<Parameters<typeof defineQuery<TResponse, TVars, TScope, TStored>>[0], 'key' | 'into'> & {
    key?: string;
    into?: Parameters<typeof defineQuery<TResponse, TVars, TScope, TStored>>[0]['into'];
    /** Colocated live subscription entries, delivered through the model ingest pipeline while readers are mounted. */
    live?: Record<string, ModelIngestEntry>;
};
type ModelMutationConfig<TData, TInput, TStored extends {
    id: string;
}, TNode> = Omit<MutationConfig<TData, TInput, TStored, TNode>, 'dedupe'> & {
    dedupe?: false | MutationConfig<TData, TInput, TStored, TNode>['dedupe'];
};
type ModelFetchConfig<TData, TInput, TSelected> = Omit<Parameters<typeof defineFetch<TData, TInput, TSelected>>[0], 'key'> & {
    key?: string;
};
type CrudSection = Record<string, unknown>;
type CrudQueryHandle = ReturnType<typeof defineQuery<unknown, unknown, unknown, {
    id: string;
}>>;
type CrudCreateHandle = ReturnType<typeof defineMutation<unknown, unknown, {
    id: string;
}, unknown>>;
type CrudIdMutationHandle = ReturnType<typeof defineMutation<unknown, {
    id: string;
} & Record<string, unknown>, {
    id: string;
}, unknown>>;
type CrudHandle<K extends keyof CrudSections> = K extends 'list' | 'get' ? CrudQueryHandle : K extends 'update' | 'destroy' ? CrudIdMutationHandle : CrudCreateHandle;
export type CrudSections = {
    /** List query configuration. `into` is required and must be a scope handle. */
    list?: CrudSection & {
        into: ScopeHandle<{
            id: string;
        }, unknown>;
    };
    /** Get query configuration; destination defaults to this model. */
    get?: CrudSection;
    /** Create mutation configuration; provide `respond` or `build` with `selectServerNode`. */
    create?: CrudSection;
    /** Update mutation configuration; default optimistic patch reads `input.id`. */
    update?: CrudSection;
    /** Destroy mutation configuration; default optimistic destroy reads `input.id`. */
    destroy?: CrudSection;
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
    /** Reactive scope rows. `keepPrevious` opt-in retains the prior non-empty key until this key resolves. */
    use<TProjection extends Record<string, unknown>>(scopeValue: TScope | null | undefined, opts: {
        select: (row: TStored) => TProjection;
        renderKeys?: never;
    } & KeepPreviousOption): TProjection[];
    use(scopeValue: TScope | null | undefined, opts?: {
        select?: never;
        renderKeys?: readonly (keyof TStored & string)[];
    } & KeepPreviousOption): TStored[];
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
        select?: never;
        renderKeys?: readonly (keyof TStored & string)[];
    } & KeepPreviousOption): ScopeWindowResult<TStored>;
    useWindow<TProjection extends Record<string, unknown>>(scopeValue: TScope | null | undefined, opts: {
        pageSize?: number;
        select: (row: TStored) => TProjection;
        renderKeys?: never;
    } & KeepPreviousOption): ScopeWindowResult<TProjection>;
    /** Reactive count of rows currently in the scope. */
    useCount(scopeValue: TScope | null | undefined): number;
    /** Clear this scope's fetch-state and invalidate its derived React Query key(s). */
    invalidate(scopeValue?: TScope): void;
    /** Synchronous snapshot read of the scope's rows, in sort order; safe to call outside React. */
    read(scopeValue: TScope): TStored[];
    __apply?(scopeValue: TScope, rows: TStored[], coverage: ScopeCoverage, opts?: {
        resetOrder?: boolean;
    }): void;
    __planApply?(scopeValue: TScope, rows: Array<{
        row: TStored;
        edge?: Record<string, unknown>;
    }>, coverage: ScopeCoverage, opts?: {
        resetOrder?: boolean;
    }): JournalOp[];
    __key?(scopeValue: TScope): string;
    __isServerOrder?(): boolean;
    __planPlacement?(scopeValue: TScope, id: string, position: 'prepend' | 'append'): JournalOp[];
    __readRows?(scopeValue: TScope): TStored[];
    __isResolved?(scopeValue: TScope): boolean;
    __noteAccess?(scopeValue: TScope): void;
};
export type ModelCore<TStored extends {
    id: string;
    updatedAt?: string | null;
}> = {
    modelId: string;
    /** Define a model-owned query with colocated live subscription entries; the returned handle adds `live.apply`. */
    query<TResponse, TVars, TScope, TRow extends {
        id: string;
    }>(name: string, config: ModelQueryConfig<TResponse, TVars, TScope, TRow> & {
        live: Record<string, ModelIngestEntry>;
    }): ReturnType<typeof defineQuery<TResponse, TVars, TScope, TRow>> & {
        live: LiveQueryHandle;
    };
    /** Define a model-owned query with a conventional `<modelId>:<name>` key and this model as the default destination. */
    query<TResponse, TVars, TScope, TRow extends {
        id: string;
    }>(name: string, config: ModelQueryConfig<TResponse, TVars, TScope, TRow>): ReturnType<typeof defineQuery<TResponse, TVars, TScope, TRow>>;
    /** Define a model-owned mutation with conventional input-sensitive deduplication; pass `dedupe: false` to opt out. */
    mutation<TData, TInput, TRow extends {
        id: string;
    }, TNode>(name: string, config: ModelMutationConfig<TData, TInput, TRow, TNode>): ReturnType<typeof defineMutation<TData, TInput, TRow, TNode>>;
    /** Compose conventional resource handles.
     * @param sections Present resource sections and their builder-derived configuration.
     * @returns Exactly the handles for the present section keys.
     */
    crud<TSections extends CrudSections>(sections: TSections): {
        [K in keyof TSections & keyof CrudSections]: CrudHandle<K>;
    };
    /** Define an ephemeral model-namespaced fetch with a conventional `<modelId>:<name>` key. */
    fetch<TData, TInput = void, TSelected = TData>(name: string, config: ModelFetchConfig<TData, TInput, TSelected>): ReturnType<typeof defineFetch<TData, TInput, TSelected>>;
    /** Define a refcounted status poller owned by this model; failures log with `<modelId>:<name>`. */
    poller<TData>(name: string, config: {
        document: DbGraphQLDocument<TData, {
            id: string;
        }>;
        vars?: (id: string) => Record<string, unknown>;
        apply: (id: string, data: TData) => void;
        isTerminal: (data: TData) => boolean;
        intervalMs: number;
        maxAttempts: number;
        onSessionStop?: (id: string, reason: 'terminal' | 'budget') => void;
    }): ModelStatusPoller;
    /** Define a reactive joined projection over one declared scope and its current related rows. */
    view<TItem = TStored & Record<string, unknown>>(name: string, config: ViewConfig<TItem>): ViewHandle<TItem, Record<string, unknown>>;
    /** Define model-owned subscription entries that apply rows, guards, effects, and custom handlers together. */
    ingest(entries: Record<string, ModelIngestEntry>): {
        entries: DbSubscriptionEntry[];
        apply(key: string, payload: unknown): void;
    };
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
        /** Read one field from one row. */
        field<K extends keyof TStored>(id: string | null | undefined, field: K): TStored[K] | undefined;
        /** Read one row or a shallow-gated projection; selector identity may change without becoming a dependency. */
        row<TProjection extends Record<string, unknown>>(id: string | null | undefined, opts: {
            select: (row: TStored) => TProjection;
            renderKeys?: never;
            require?: readonly (keyof TStored & string)[];
        }): TProjection | undefined;
        row(id: string | null | undefined, opts?: {
            select?: never;
            renderKeys?: readonly (keyof TStored & string)[];
            require?: readonly (keyof TStored & string)[];
        }): TStored | undefined;
        /** Read the first matching row or a shallow-gated projection after ordering and required-field filtering. */
        first<TProjection extends Record<string, unknown>>(where: DbWhere<TStored> | null | undefined, opts: DbReadOptions<TStored> & {
            select: (row: TStored) => TProjection;
            renderKeys?: never;
            require?: readonly (keyof TStored & string)[];
        }): TProjection | undefined;
        first(where?: DbWhere<TStored> | null, opts?: DbReadOptions<TStored> & {
            select?: never;
            renderKeys?: readonly (keyof TStored & string)[];
            require?: readonly (keyof TStored & string)[];
        }): TStored | undefined;
        where(where: DbWhere<TStored> | null): ModelReadBuilder<TStored>;
        /** Read ids in input order with stable rows and an id-keyed map; nullish ids return an unsubscribed empty result. */
        byIds<TProjection extends Record<string, unknown>>(ids: readonly string[] | null | undefined, opts: {
            select: (row: TStored) => TProjection;
            renderKeys?: never;
        }): {
            rows: TProjection[];
            byId: ReadonlyMap<string, TProjection>;
        };
        byIds(ids: readonly string[] | null | undefined, opts?: {
            select?: never;
            renderKeys?: readonly (keyof TStored & string)[];
        }): {
            rows: TStored[];
            byId: ReadonlyMap<string, TStored>;
        };
        count(where?: DbWhere<TStored> | null): number;
        /** Read a declared relation, optionally projecting row-valued relation results through the shared gate. */
        related<TProjection extends Record<string, unknown>>(id: string | null | undefined, relation: string, opts: {
            select: (row: TStored) => TProjection;
            renderKeys?: never;
        }): TProjection[];
        related(id: string | null | undefined, relation: string, opts?: {
            select?: never;
            renderKeys?: readonly string[];
        }): unknown;
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
    __revision?(): number;
};
type RequiredReadUse<TStored extends {
    id: string;
    updatedAt?: string | null;
}, TKey extends keyof TStored & string> = Omit<ModelCore<TStored>['use'], 'row' | 'first'> & {
    row<TProjection extends Record<string, unknown>>(id: string | null | undefined, opts: {
        select: (row: TStored) => TProjection;
        renderKeys?: never;
        require?: readonly TKey[];
    }): TProjection | undefined;
    row<K extends TKey>(id: string | null | undefined, opts: {
        select?: never;
        renderKeys?: readonly (keyof TStored & string)[];
        require: readonly K[];
    }): RequiredFields<TStored, K> | undefined;
    row(id: string | null | undefined, opts?: {
        select?: never;
        renderKeys?: readonly (keyof TStored & string)[];
        require?: never;
    }): TStored | undefined;
    first<TProjection extends Record<string, unknown>>(where: DbWhere<TStored> | null | undefined, opts: DbReadOptions<TStored> & {
        select: (row: TStored) => TProjection;
        renderKeys?: never;
        require?: readonly TKey[];
    }): TProjection | undefined;
    first<K extends TKey>(where: DbWhere<TStored> | null | undefined, opts: DbReadOptions<TStored> & {
        select?: never;
        renderKeys?: readonly (keyof TStored & string)[];
        require: readonly K[];
    }): RequiredFields<TStored, K> | undefined;
    first(where?: DbWhere<TStored> | null, opts?: DbReadOptions<TStored> & {
        select?: never;
        renderKeys?: readonly (keyof TStored & string)[];
        require?: never;
    }): TStored | undefined;
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
    /** Boot maintenance declarations. Temp-row cleanup at boot is handled by the replay orphan sweep and needs no maintenance entry. */
    maintenance?: {
        /** Opt-in idle scope collection: unread scopes are removed at the next GC sweep after this duration, then their rows follow normal reachability. */
        dropIdleScopesAfterMs?: number;
        maxRowsPerScope?: Array<{
            scopeField: keyof InferStoredFields<TFields> & string;
            limit: number;
            compare: (left: InferStoredFields<TFields>, right: InferStoredFields<TFields>) => number;
            /** Evaluated at run time - may read OTHER models. */ protect?: () => (row: InferStoredFields<TFields>) => boolean;
        }>;
    };
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
export declare const defineModel: <const TFields extends ModelFieldSpecs, TScopes extends Record<string, ScopeSpec<any>> = {}, TExt extends Record<string, unknown> = {}>(config: ModelConfig<TFields, TScopes, TExt>) => Omit<ModelCore<any>, "use"> & {
    use: RequiredReadUse<InferStoredFields<TFields>, Extract<keyof TFields, keyof InferStoredFields<TFields> & string> | "id">;
    scopes: { [K in keyof TScopes]: ScopeHandle<any, ScopeValueOf<TScopes[K]>>; };
} & TExt;
export {};
//# sourceMappingURL=defineModel.d.ts.map