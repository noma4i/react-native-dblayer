import type { ModelLandingHost, WriteOp } from '../types';
export declare const registerModelLandingHost: (model: string, host: ModelLandingHost) => void;
export declare const planModelLanding: (model: string, rows: unknown[], options?: {
    origin?: "event";
}) => WriteOp[];
/**
 * Plan a graph while replacing the root model's ordinary upsert planner.
 *
 * @param model Root model key.
 * @param rows Raw root rows.
 * @param planRoot Root-specific planner such as identity replacement.
 * @param options Write origin propagated to non-root graph nodes.
 * @returns Deduplicated write operations for all models in the graph.
 */
export declare const planModelLandingWithRoot: (model: string, rows: unknown[], planRoot: (rows: unknown[], options?: {
    origin?: "event";
}) => WriteOp[], options?: {
    origin?: "event";
}) => WriteOp[];
//# sourceMappingURL=modelLandingGraph.d.ts.map