import type { AnyDbShape, InferShapeStored } from '../schema/infer';
type RowId = {
    id: string;
};
type CreatedAtLike = string | number | Date | null | undefined;
type CreatedAtRow = RowId & {
    createdAt?: CreatedAtLike;
};
type SnapshotModel<TStored extends RowId> = {
    get(id: string | undefined | null): TStored | undefined;
    getAll(): TStored[];
    getWhere(filter: Partial<TStored>): TStored[];
};
type DestroyManyModel<TStored extends RowId> = {
    getAll(): TStored[];
    destroyMany(ids: string[]): void;
};
type PatchModel<TStored extends RowId> = {
    get(id: string): TStored | undefined;
    patch(id: string, updates: Partial<TStored>): boolean | void;
};
type SingletonModel<TStored extends RowId> = PatchModel<TStored> & {
    insertStored(item: TStored): void;
    use: {
        row(id: string | null | undefined): TStored | undefined;
    };
};
export type ReconcileScopeFields<TStored extends RowId, TNode extends RowId> = {
    fields: ReadonlyArray<Extract<keyof TStored & keyof TNode, string>>;
} | {
    fieldMap: Partial<Record<Extract<keyof TStored, string>, Extract<keyof TNode, string>>>;
};
export type ReconcileOptimisticRowsOptions<TStored extends CreatedAtRow, TNode extends CreatedAtRow> = {
    /** Candidate resolver, or a scope-field shorthand backed by `model.getWhere`. */
    resolveCandidates: ((node: TNode) => TStored[]) | ReconcileScopeFields<TStored, TNode>;
    /** Extra candidate predicate. Temp ids are always considered candidates. */
    isCandidate?: (candidate: TStored, node: TNode) => boolean;
    /** Domain equality check between an optimistic row and a server node. */
    match: (candidate: TStored, node: TNode) => boolean;
    /** Drop matches whose created-at timestamps are farther apart than this window. */
    createdAtWindowMs?: number;
    /** Commit a matched optimistic row to the server node. */
    commit: (tempId: string, node: TNode) => void;
    /**
     * How to handle an incoming node whose id already exists in the model.
     *
     * - `'drop'` (default): the node is silently skipped - neither returned nor committed. This is the
     *   original behavior; callers that need to apply an existing-id node as an update have to pre-check
     *   `model.get(node.id)` themselves before calling this function.
     * - `'return'`: the node is pushed into the returned array as-is, with no candidate matching attempted
     *   and no `commit` call - e.g. a subscription echo of a row already applied by its own mutation
     *   response. The caller decides how to apply it (patch, replace, or ignore).
     *
     * @default 'drop'
     */
    onExisting?: 'drop' | 'return';
};
/**
 * Reconcile incoming server nodes with matching optimistic rows.
 *
 * @param model Snapshot model used to check existing rows and scoped optimistic candidates.
 * @param nodes Incoming server nodes.
 * @param options Candidate resolution, matching, timestamp window, commit callback, and `onExisting`
 * policy for nodes whose id already exists in the model.
 * @returns Server nodes that were not matched, plus (with `onExisting: 'return'`) nodes whose id already
 * existed in the model.
 */
export declare const reconcileOptimisticRows: <TStored extends CreatedAtRow, TNode extends CreatedAtRow>(model: SnapshotModel<TStored>, nodes: TNode[], options: ReconcileOptimisticRowsOptions<TStored, TNode>) => TNode[];
/**
 * Delete rows whose foreign key no longer points at a live parent id.
 *
 * @param model Model that can snapshot rows and destroy by id.
 * @param foreignKeyField Row field that stores the parent id.
 * @param liveParentIds Live parent ids accepted by the cleanup pass.
 * @returns Number of rows deleted through `destroyMany`.
 */
export declare const pruneOrphanedRows: <TStored extends RowId, TForeignKey extends Extract<keyof TStored, string>>(model: DestroyManyModel<TStored>, foreignKeyField: TForeignKey, liveParentIds: ReadonlySet<string> | readonly string[]) => number;
/**
 * Delete rows whose timestamp field is older than the supplied TTL.
 *
 * Invalid timestamps are kept.
 *
 * @param model Model that can snapshot rows and destroy by id.
 * @param field Row field containing a string, number, or Date timestamp.
 * @param ttlMs Maximum allowed age in milliseconds.
 * @param now Reference time; defaults to `Date.now()`.
 * @returns Number of rows deleted through `destroyMany`.
 */
export declare const pruneExpiredRows: <TStored extends RowId, TField extends Extract<keyof TStored, string>>(model: DestroyManyModel<TStored>, field: TField, ttlMs: number, now?: CreatedAtLike) => number;
export type RowProtect<TStored extends RowId> = ((row: TStored) => boolean) | ReadonlySet<string> | readonly string[];
/**
 * Keep at most `maxPerScope` unprotected rows in each scope.
 *
 * The supplied comparator must order rows from newest/most important to oldest.
 *
 * @param model Model that can snapshot rows and delete rows for maintenance.
 * @param scopeField Row field used to group rows.
 * @param maxPerScope Maximum unprotected rows kept per scope.
 * @param compare Comparator applied inside each scope before trimming.
 * @param protect Optional protected row predicate or id list.
 * @returns Number of rows deleted.
 */
export declare const trimRowsPerScope: <TStored extends RowId, TScopeField extends Extract<keyof TStored, string>>(model: DestroyManyModel<TStored>, scopeField: TScopeField, maxPerScope: number, compare: (left: TStored, right: TStored) => number, protect?: RowProtect<TStored>) => number;
export type ResolveStaleTempRowsOptions<TStored extends CreatedAtRow> = {
    maxAgeMs: number;
    protectedIds?: ReadonlySet<string> | readonly string[];
    onStale: (row: TStored) => void;
};
/**
 * Run `onStale` for temp-id rows older than the age threshold and not protected.
 *
 * @param model Snapshot model used to scan temp rows.
 * @param options Age threshold, optional protected ids, and stale-row callback.
 * @returns Number of stale temp rows resolved.
 */
export declare const resolveStaleTempRows: <TStored extends CreatedAtRow>(model: Pick<DestroyManyModel<TStored>, "getAll">, options: ResolveStaleTempRowsOptions<TStored>) => number;
export type ThrottledSingleFlightOptions<TArgs extends unknown[]> = {
    minIntervalMs: number;
    /** Override throttle suppression; defaults to reading `args[0].force === true`. */
    isForced?: (...args: TArgs) => boolean;
};
/**
 * Coalesce concurrent calls and suppress calls inside the post-success interval.
 *
 * Suppressed calls and failed executions resolve to `undefined`.
 *
 * @param fn Async task to run at most once concurrently.
 * @param options Minimum post-success interval and optional force predicate.
 * @returns A wrapped function that shares in-flight work and resolves `undefined` for suppressed or failed calls.
 */
export declare const createThrottledSingleFlight: <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => Promise<TResult>, options: ThrottledSingleFlightOptions<TArgs>) => ((...args: TArgs) => Promise<TResult | undefined>);
export type KeyedBatchBufferDedupe<TItem> = {
    /** Stable dedupe id for an item inside a keyed bucket. */
    idOf: (item: TItem) => string;
    /** Return true when the candidate should replace the existing item with the same dedupe id. */
    isNewer: (candidate: TItem, existing: TItem) => boolean;
};
export type KeyedBatchBufferConfig<TItem> = {
    /** Bucket key for an incoming item. */
    keyOf: (item: TItem) => string;
    /** Trailing flush delay for each independent bucket. */
    flushMs: number;
    /** Flush a bucket synchronously when its buffered item count reaches this size. */
    maxSize?: number;
    /** Optional newest-wins dedupe policy inside each bucket. */
    dedupe?: KeyedBatchBufferDedupe<TItem>;
    /** Flush callback. Errors are contained and logged. */
    onFlush: (key: string, items: TItem[]) => void;
};
export type KeyedBatchBuffer<TItem> = {
    /** Push an item into its keyed bucket and start or refresh that bucket's trailing timer. */
    push(item: TItem): void;
    /** Flush every non-empty bucket immediately. */
    flushAll(): void;
    /** Drop every bucket without firing `onFlush`. */
    clear(): void;
};
/**
 * Create a keyed trailing batch buffer with independent bucket timers.
 *
 * @param config Keying, timing, optional cap/dedupe policy, and flush callback.
 * @returns Runtime buffer controls for pushing, flushing, and clearing pending items.
 */
export declare const createKeyedBatchBuffer: <TItem>(config: KeyedBatchBufferConfig<TItem>) => KeyedBatchBuffer<TItem>;
export type NestedObjectPatcher<TRow extends RowId, TField extends Extract<keyof TRow, string>, TArgs extends unknown[]> = (id: string, ...args: TArgs) => boolean;
export type KeyedArrayPatcher<TSub extends object, TKey extends Extract<keyof TSub, string>> = {
    /** Replace an existing sub-row with the same key, then append the normalized sub-row. */
    upsert(rows: TSub[] | null | undefined, input: unknown): TSub[];
    /** Remove sub-rows whose key equals the supplied value. */
    remove(rows: TSub[] | null | undefined, keyValue: string): TSub[];
};
export type IdArrayPatcher = {
    /** Replace an existing id, then insert it at the requested edge. */
    upsert(ids: string[] | null | undefined, id: string, position: 'prepend' | 'append'): string[];
    /** Remove an id. */
    remove(ids: string[] | null | undefined, id: string): string[];
};
/**
 * Create immutable patch helpers for an array of keyed shape sub-rows.
 *
 * @param shape Shape used to normalize incoming sub-rows.
 * @param options Key field used for replacement/removal.
 * @returns Immutable `upsert` and `remove` helpers for nullable arrays.
 */
export declare const createKeyedArrayPatcher: <TShape extends AnyDbShape, TSub extends InferShapeStored<TShape>, TKey extends Extract<keyof TSub, string>>(shape: TShape, options: {
    key: TKey;
}) => KeyedArrayPatcher<TSub, TKey>;
/**
 * Create immutable patch helpers for id arrays.
 *
 * @returns Immutable `upsert` and `remove` helpers that tolerate nullish arrays.
 */
export declare const createIdArrayPatcher: () => IdArrayPatcher;
/**
 * Create a shallow patcher for a nullable nested object field.
 *
 * @param model Model used to read and patch the containing row.
 * @param field Nested object field to patch.
 * @param transform Function that derives a partial nested update from the current nested value and caller args.
 * @returns A patcher that returns `false` when the row or nested object is missing.
 */
export declare const createNestedObjectPatcher: <TRow extends RowId, TField extends Extract<keyof TRow, string>, TArgs extends unknown[], TNested extends object = NonNullable<TRow[TField]> & object>(model: PatchModel<TRow>, field: TField, transform: (current: TNested, ...args: TArgs) => Partial<TNested>) => NestedObjectPatcher<TRow, TField, TArgs>;
type NumericField<TStored> = {
    [K in keyof TStored]: TStored[K] extends number ? K : never;
}[keyof TStored];
/**
 * Build statics for a single-row model with defaults and clamped numeric updates.
 *
 * @param model Model that owns the singleton row.
 * @param recordId Stable singleton row id.
 * @param defaults Default row returned before insertion and used for first upsert.
 * @returns Singleton statics for reading, upserting, and clamped numeric patches.
 */
export declare const singletonStatics: <TStored extends RowId>(model: SingletonModel<TStored>, recordId: string, defaults: TStored) => {
    recordId: string;
    defaults: TStored;
    current: () => TStored | undefined;
    useCurrent: () => TStored;
    upsertCurrent: (input: Partial<TStored>) => void;
    patchClamped: <TField extends Extract<NumericField<TStored>, string>>(field: TField, delta: number, min?: number) => boolean;
};
export {};
//# sourceMappingURL=runtimePrimitives.d.ts.map