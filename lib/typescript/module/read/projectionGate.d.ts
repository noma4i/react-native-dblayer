import type { Dependency, ProjectionGate, ProjectionOptions, RowRecord } from '../types';
/** Throw when a row-level read declares both mutually exclusive projection modes. Views may explicitly allow render keys over selected output. */
export declare const validateProjectionOptions: (options: {
    select?: unknown;
    renderKeys?: readonly string[];
} | undefined, surface: string, validation?: {
    allowCombined?: boolean;
}) => void;
/** Create one hook-local row projection gate with stable item and array references. */
export declare const createProjectionGate: <TStored extends RowRecord, TOutput extends Record<string, unknown>>() => ProjectionGate<TStored, TOutput>;
/** Read and gate one optional stored row while keeping selector identity outside dependencies. */
export declare const useProjectedLiveRow: <TStored extends RowRecord, TOutput extends Record<string, unknown>>(compute: () => TStored | undefined, deps: ReadonlyArray<Dependency>, options: ProjectionOptions<TStored, TOutput>, surface: string) => TOutput | undefined;
/** Read and gate stored rows while keeping selector identity outside dependencies. */
export declare const useProjectedLiveRows: <TStored extends RowRecord, TOutput extends Record<string, unknown>>(compute: () => TStored[], deps: ReadonlyArray<Dependency>, options: ProjectionOptions<TStored, TOutput>, surface: string) => TOutput[];
//# sourceMappingURL=projectionGate.d.ts.map