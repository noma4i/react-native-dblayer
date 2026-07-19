import type { Dependency } from '../core/apply/commitBus';
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
/** Throw when a row-level read declares both mutually exclusive projection modes. Views may explicitly allow render keys over selected output. */
export declare const validateProjectionOptions: (options: {
    select?: unknown;
    renderKeys?: readonly string[];
} | undefined, surface: string, validation?: {
    allowCombined?: boolean;
}) => void;
/** Create one hook-local row projection gate with stable item and array references. */
export declare const createProjectionGate: <TStored extends Row, TOutput extends Record<string, unknown>>() => {
    projectValue(id: string, source: unknown, output: TOutput, renderKeys?: readonly string[]): TOutput;
    project(row: TStored, options: ProjectionOptions<TStored, TOutput>): TOutput;
    projectRows(rows: TStored[], options: ProjectionOptions<TStored, TOutput>): TOutput[];
};
/** Read and gate one optional stored row while keeping selector identity outside dependencies. */
export declare const useProjectedLiveRow: <TStored extends Row, TOutput extends Record<string, unknown>>(compute: () => TStored | undefined, deps: ReadonlyArray<Dependency>, options: ProjectionOptions<TStored, TOutput>, surface: string) => TOutput | undefined;
/** Read and gate stored rows while keeping selector identity outside dependencies. */
export declare const useProjectedLiveRows: <TStored extends Row, TOutput extends Record<string, unknown>>(compute: () => TStored[], deps: ReadonlyArray<Dependency>, options: ProjectionOptions<TStored, TOutput>, surface: string) => TOutput[];
export {};
//# sourceMappingURL=projectionGate.d.ts.map