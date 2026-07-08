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
    destroyMany(ids: string[]): number;
    _deleteManyWithoutFreshness?: (ids: string[]) => number;
};
type PatchModel<TStored extends RowId> = {
    get(id: string): TStored | undefined;
    patch(id: string, updates: Partial<TStored>): boolean | void;
};
type SingletonModel<TStored extends RowId> = PatchModel<TStored> & {
    find(id: string): TStored | undefined;
    insertStored(item: TStored): void;
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
};
/**
 * Reconcile incoming server nodes with matching optimistic rows.
 * @returns Server nodes that were not matched or skipped as already present.
 */
export declare const reconcileOptimisticRows: <TStored extends CreatedAtRow, TNode extends CreatedAtRow>(model: SnapshotModel<TStored>, nodes: TNode[], options: ReconcileOptimisticRowsOptions<TStored, TNode>) => TNode[];
/** Delete rows whose foreign key no longer points at a live parent id. */
export declare const pruneOrphanedRows: <TStored extends RowId, TForeignKey extends Extract<keyof TStored, string>>(model: DestroyManyModel<TStored>, foreignKeyField: TForeignKey, liveParentIds: ReadonlySet<string> | readonly string[]) => number;
/** Delete rows whose timestamp field is older than the supplied TTL. Invalid timestamps are kept. */
export declare const pruneExpiredRows: <TStored extends RowId, TField extends Extract<keyof TStored, string>>(model: DestroyManyModel<TStored>, field: TField, ttlMs: number, now?: CreatedAtLike) => number;
export type RowProtect<TStored extends RowId> = ((row: TStored) => boolean) | ReadonlySet<string> | readonly string[];
/**
 * Keep at most `maxPerScope` unprotected rows in each scope.
 * The supplied comparator must order rows from newest/most important to oldest.
 */
export declare const trimRowsPerScope: <TStored extends RowId, TScopeField extends Extract<keyof TStored, string>>(model: DestroyManyModel<TStored>, scopeField: TScopeField, maxPerScope: number, compare: (left: TStored, right: TStored) => number, protect?: RowProtect<TStored>) => number;
export type ResolveStaleTempRowsOptions<TStored extends CreatedAtRow> = {
    maxAgeMs: number;
    protectedIds?: ReadonlySet<string> | readonly string[];
    onStale: (row: TStored) => void;
};
/** Run `onStale` for temp-id rows older than the age threshold and not protected. */
export declare const resolveStaleTempRows: <TStored extends CreatedAtRow>(model: Pick<DestroyManyModel<TStored>, "getAll">, options: ResolveStaleTempRowsOptions<TStored>) => number;
export type ThrottledSingleFlightOptions<TArgs extends unknown[]> = {
    minIntervalMs: number;
    /** Override throttle suppression; defaults to reading `args[0].force === true`. */
    isForced?: (...args: TArgs) => boolean;
};
/**
 * Coalesce concurrent calls and suppress calls inside the post-success interval.
 * Suppressed calls and failed executions resolve to `undefined`.
 */
export declare const createThrottledSingleFlight: <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => Promise<TResult>, options: ThrottledSingleFlightOptions<TArgs>) => ((...args: TArgs) => Promise<TResult | undefined>);
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
/** Create immutable patch helpers for an array of keyed shape sub-rows. */
export declare const createKeyedArrayPatcher: <TShape extends AnyDbShape, TSub extends InferShapeStored<TShape>, TKey extends Extract<keyof TSub, string>>(shape: TShape, options: {
    key: TKey;
}) => KeyedArrayPatcher<TSub, TKey>;
/** Create immutable patch helpers for id arrays. */
export declare const createIdArrayPatcher: () => IdArrayPatcher;
/** Create a shallow patcher for a nullable nested object field. */
export declare const createNestedObjectPatcher: <TRow extends RowId, TField extends Extract<keyof TRow, string>, TArgs extends unknown[], TNested extends object = NonNullable<TRow[TField]> & object>(model: PatchModel<TRow>, field: TField, transform: (current: TNested, ...args: TArgs) => Partial<TNested>) => NestedObjectPatcher<TRow, TField, TArgs>;
type NumericField<TStored> = {
    [K in keyof TStored]: TStored[K] extends number ? K : never;
}[keyof TStored];
/** Build statics for a single-row model with defaults and clamped numeric updates. */
export declare const singletonStatics: <TStored extends RowId>(model: SingletonModel<TStored>, recordId: string, defaults: TStored) => {
    recordId: string;
    defaults: TStored;
    current: () => TStored | undefined;
    useCurrent: () => TStored;
    upsert: (input: Partial<TStored>) => void;
    upsertCurrent: (input: Partial<TStored>) => void;
    patchClamped: <TField extends Extract<NumericField<TStored>, string>>(field: TField, delta: number, min?: number) => boolean;
};
export {};
//# sourceMappingURL=runtimePrimitives.d.ts.map