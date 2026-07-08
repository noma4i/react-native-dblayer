import type { StoredRowBase } from '../types';
export type ModelWriteKind = 'insert' | 'update';
export type ModelWritePropagator<TRow extends StoredRowBase = StoredRowBase> = (row: TRow, kind: ModelWriteKind) => void;
export declare const isWritePropagationActive: () => boolean;
export declare const runWithoutWritePropagation: <T>(fn: () => T) => T;
export declare const createWritePropagation: <TRow extends StoredRowBase = StoredRowBase>() => {
    register(propagator: ModelWritePropagator<TRow>): void;
    announce(row: TRow, kind: ModelWriteKind): void;
};
//# sourceMappingURL=writePropagation.d.ts.map