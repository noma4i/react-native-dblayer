import type { EntityPlaneOptions, PreparedUpsert, RowRecord, WriteCtx } from '../types';
export declare const diffTopLevelFields: (previous: RowRecord, next: RowRecord) => string[];
/** True when every changed field is only a reference change with identical serialized value (upsert guard). */
export declare const isSerializedNoop: (previous: RowRecord, row: RowRecord, changedFields: string[]) => boolean;
/**
 * Pure single-write resolver: id coercion, pending-field overlay, write-gate application, and the
 * serialized-noop upsert guard - no plane state is read or mutated.
 */
export declare const createUpsertResolver: (options: Pick<EntityPlaneOptions, "applyWriteGate" | "ownedFields">) => {
    previewUpsert: (incoming: RowRecord, upsertOptions: {
        previous: RowRecord | undefined;
        mergeBase?: RowRecord;
        ctx?: WriteCtx;
    }) => PreparedUpsert<RowRecord>;
};
//# sourceMappingURL=storeUpsertResolver.d.ts.map