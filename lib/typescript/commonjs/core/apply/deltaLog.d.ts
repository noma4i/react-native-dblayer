import type { AppliedOp, StoragePlane } from '../../types';
export declare const deltaKey: (prefix: string, seq: number) => string;
export declare const snapseqKey: (prefix: string, model: string) => string;
/** Light delta codec: the ops already passed the lossless gate at plan time - one stringify pass, no checksum. */
export declare const encodeDelta: (seq: number, ops: AppliedOp[]) => string;
export type DecodedDelta = {
    seq: number;
    ops: AppliedOp[];
};
/** Version discrimination runs BEFORE the shape gate: a foreign recordVersion is format evolution ('stale'), everything else that fails is corruption (null). */
export declare const decodeDelta: (raw: string) => DecodedDelta | "stale" | null;
export declare const readSnapseq: (storage: StoragePlane, prefix: string, model: string) => number;
/**
 * Read the persisted delta tail in seq order. A broken delta cuts the tail: it and every later
 * delta are removed with a loss counter, and every persisted query record is evicted so each
 * reader refetches on its next mount instead of trusting a snapshot with a hole in it.
 */
export declare const readDeltaLog: (storage: StoragePlane, prefix: string) => DecodedDelta[];
/** Highest seq the disk knows: the next session's counter continues after it. */
export declare const highestPersistedSeq: (storage: StoragePlane, prefix: string) => number;
//# sourceMappingURL=deltaLog.d.ts.map