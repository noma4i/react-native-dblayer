import { getOperationState } from './configure';
import type { ExtractSink } from './defineQuery';
import { type DbSubscriptionEntry } from '../core/subscriptionRuntime';
export type IngestDecl = {
    upsert?: unknown | unknown[];
    destroy?: string | string[];
    /** Invalidates only the query cache entries whose scope matches this object (exact or partial, per Model.invalidate semantics). */
    invalidate?: object;
    /** Full-model invalidation (every query prefix on the model) instead of a scoped one; use `invalidate` for the scoped case. */
    invalidateAll?: true;
    /** Echo guard: when this operation id already committed locally, the whole event is skipped. */
    operationId?: string | null;
    /** Cross-model sideloads applied in the SAME transaction as the event rows. */
    extract?: ExtractSink[];
};
type IngestHandle = {
    apply(event: string, payload: unknown): IngestDecl | null;
};
type IngestModel = {
    modelId: string;
    name?: string;
    find(id: string | null | undefined): unknown;
    insert(row: unknown): void;
    invalidate(scope?: unknown): void;
};
/** Register a model for the named-model lookup exposed to fused custom ingest handlers. */
export declare const registerIngestModel: (name: string, model: IngestModel) => void;
export type ModelIngestTools = {
    /** Model that owns this fused ingest declaration. */
    model: IngestModel;
    /** Invalidate all queries registered for the owner model. */
    invalidate: () => void;
    /** Shared operation ledger for advanced custom handlers. */
    operations: ReturnType<typeof getOperationState>;
    /** Models registered by `defineModel` name for multi-model custom handlers. */
    models: Record<string, IngestModel>;
};
export type ModelIngestEntry = {
    /** Subscription document passed to the configured transport. Required unless `handler` is used only for imperative delivery. */
    document?: DbSubscriptionEntry['query'];
    /** Declaration-return handler using the exact atomic `defineIngest` apply pipeline. */
    handler?: (payload: unknown) => IngestDecl | null;
    /** Transform the runtime payload before guard, effects, and apply. */
    payload?: (data: unknown) => unknown;
    /** Apply normalized rows, destroy an id, or run a custom model-aware handler. */
    apply?: 'upsert' | 'destroy' | ((payload: unknown, tools: ModelIngestTools) => void);
    /** Apply only to an already-present row, or use a custom acceptance predicate. */
    guard?: 'existing' | ((payload: unknown) => boolean);
    /** Return true to skip an own-echo subscription payload. */
    echoGuard?: (payload: unknown) => boolean;
    /** Trailing debounce delegated to the subscription runtime. */
    debounce?: DbSubscriptionEntry['debounce'];
    /** Invoke an injected named effect before or after apply. */
    effect?: {
        name: string;
        when: 'before' | 'after';
    };
};
/**
 * Fuse model-owned subscription declarations with the existing ingest apply pipeline.
 *
 * @param model Model receiving mechanical rows and exposed to custom handlers.
 * @param entries Subscription event declarations keyed by their root-field name.
 * @returns Subscription entries accepted directly by `createDbSubscriptionRuntime`.
 */
export declare const defineModelIngest: (model: IngestModel, entries: Record<string, ModelIngestEntry>) => {
    entries: DbSubscriptionEntry[];
    apply: (key: string, payload: unknown) => void;
};
/**
 * Compile a subscription event into ONE event plan: rows, destroys and extract sinks apply with
 * relation side effects (touch/counterCache/dependent) in a single epoch. Version arbitration for
 * stale events lives in the model's write acceptance gate - not here (one gate, no zoo).
 *
 * @note Honesty contract: nothing is acknowledged before the declaration is fully applied. A throw
 * from the handler or from `apply()` (e.g. a mid-plan write-group failure, see `ApplyRuntime.apply`)
 * is caught here, reported through `reportModelIngestError` (`onSyncError` + `noteIngestFailure()`
 * diagnostics), and swallowed to `null` - the event is never marked delivered on a failed apply. The
 * underlying WAL record for a failed `getApplyRuntime().apply(ops)` call stays `pending`, so a later
 * redelivery of the same event (or a boot replay) re-applies it deterministically instead of being
 * treated as already-processed.
 */
export declare const defineIngest: (model: IngestModel, handlers: Record<string, (payload: unknown) => IngestDecl | null>) => IngestHandle;
export {};
//# sourceMappingURL=defineIngest.d.ts.map