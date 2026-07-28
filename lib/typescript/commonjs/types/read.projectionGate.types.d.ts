import type { RowRecord } from './db.types';
export type ProjectionOptions<TStored extends RowRecord, TProjection extends Record<string, unknown> = TStored> = {
    select: (row: TStored) => TProjection;
    renderKeys?: never;
} | {
    select?: never;
    renderKeys: readonly (keyof TStored & string)[];
} | {
    select?: never;
    renderKeys?: never;
};
/** One cached projection: the source row reference, its projected output, and the equality basis. */
export type GateEntry<TOutput extends Record<string, unknown>> = {
    source: unknown;
    output: TOutput;
    equalityValue: Record<string, unknown>;
};
export type ProjectionGate<TStored extends RowRecord, TOutput extends Record<string, unknown>> = {
    projectValue(id: string, source: unknown, output: TOutput, renderKeys?: readonly string[]): TOutput;
    project(row: TStored, options: ProjectionOptions<TStored, TOutput>): TOutput;
    projectRows(rows: TStored[], options: ProjectionOptions<TStored, TOutput>): TOutput[];
};
//# sourceMappingURL=read.projectionGate.types.d.ts.map