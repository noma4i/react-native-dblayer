import type { GcHost, GcReport } from '../types';
/** Registered once per defineModel; survives resetRuntime like apply targets. */
export declare const registerGcHost: (modelId: string, host: GcHost) => (() => void);
/**
 * Reachability GC over all registered models. Roots: scope members, exempt models, pending
 * operations, mounted readers, and non-idle scopes. Edges: belongsTo/references of live rows.
 * Unreached rows are evicted (no tombstones), dead and opt-in idle scope keys removed, then
 * persistence flushes. Mounted readers are GC roots, so this is safe during in-session UI rendering.
 *
 * `bootDb`/`suspendDb` call this for you as part of the recommended startup/teardown sequence; call it
 * directly only for a different sweep cadence.
 *
 * @returns Reachability report with evicted row and removed scope counts by model.
 */
export declare const collectGarbage: () => GcReport;
//# sourceMappingURL=gc.d.ts.map