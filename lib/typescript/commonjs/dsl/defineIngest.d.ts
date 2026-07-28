import type { DbSubscriptionEntry, IngestDecl, IngestModel, ModelIngestEntry } from '../types';
type IngestHandle = {
    apply(event: string, payload: unknown): IngestDecl | null;
};
/** Register a model for the named-model lookup exposed to fused custom ingest handlers. */
export declare const registerIngestModel: (name: string, model: IngestModel) => void;
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
 * underlying WAL record for a failed `getApplyRuntime().commit(envelope)` call stays `pending`, so a later
 * redelivery of the same event (or a boot replay) re-applies it deterministically instead of being
 * treated as already-processed.
 */
export declare const defineIngest: (model: IngestModel, handlers: Record<string, (payload: unknown) => IngestDecl | null>) => IngestHandle;
export {};
//# sourceMappingURL=defineIngest.d.ts.map