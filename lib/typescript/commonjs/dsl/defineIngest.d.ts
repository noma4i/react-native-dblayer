import type { JournalOp } from '../core/apply/journal';
import type { ExtractSink } from './defineQuery';
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
    invalidate(scope?: unknown): void;
    __planRows?(rows: unknown[]): JournalOp[];
};
/**
 * Compile a subscription event into ONE event plan: rows, destroys and extract sinks apply with
 * relation side effects (touch/counterCache/dependent) in a single epoch. Version arbitration for
 * stale events lives in the model's merge.shouldOverwrite gate - not here (one gate, no zoo).
 */
export declare const defineIngest: (model: IngestModel, handlers: Record<string, (payload: unknown) => IngestDecl | null>) => IngestHandle;
export {};
//# sourceMappingURL=defineIngest.d.ts.map