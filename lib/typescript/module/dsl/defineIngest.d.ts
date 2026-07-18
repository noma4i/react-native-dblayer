import type { JournalOp } from '../core/apply/journal';
import { getOperationState } from './configure';
import type { ExtractSink } from './defineQuery';
import { type DbSubscriptionEntry } from '../core/subscriptionRuntime';
export type IngestDecl = {
    upsert?: unknown | unknown[];
    destroy?: string | string[];
    invalidate?: boolean;
    /** Echo guard: when this operation id already committed locally, the whole event is skipped. */
    operationId?: string | null;
    /** Cross-model sideloads applied in the SAME transaction as the event rows. */
    extract?: ExtractSink[];
};
export type IngestHandle = {
    apply(event: string, payload: unknown): IngestDecl | null;
};
type IngestModel = {
    modelId: string;
    name?: string;
    get(id: string | null | undefined): unknown;
    insertStored(row: unknown): void;
    invalidate(scope?: unknown): void;
    __planRows?(rows: unknown[]): JournalOp[];
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
    /** Subscription document passed to the configured transport. */
    document: DbSubscriptionEntry['query'];
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
 * stale events lives in the model's merge.shouldOverwrite gate - not here (one gate, no zoo).
 */
export declare const defineIngest: (model: IngestModel, handlers: Record<string, (payload: unknown) => IngestDecl | null>) => IngestHandle;
export {};
//# sourceMappingURL=defineIngest.d.ts.map