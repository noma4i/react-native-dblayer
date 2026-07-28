type Row = {
    id: string;
    [key: string]: unknown;
};
export type ProjectionOptions<TStored extends Row, TProjection extends Record<string, unknown> = TStored> = {
    select: (row: TStored) => TProjection;
    renderKeys?: never;
} | {
    select?: never;
    renderKeys: readonly (keyof TStored & string)[];
} | {
    select?: never;
    renderKeys?: never;
};
export type ProjectionGate<TStored extends Row, TOutput extends Record<string, unknown>> = {
    projectValue(id: string, source: unknown, output: TOutput, renderKeys?: readonly string[]): TOutput;
    project(row: TStored, options: ProjectionOptions<TStored, TOutput>): TOutput;
    projectRows(rows: TStored[], options: ProjectionOptions<TStored, TOutput>): TOutput[];
};
export {};
//# sourceMappingURL=read.projectionGate.types.d.ts.map