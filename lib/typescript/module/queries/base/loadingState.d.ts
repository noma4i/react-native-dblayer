import type { ComputePhaseInput, LoadingPhase, LoadingState } from '../../types';
/**
 * Compute the current loading phase from query and collection state.
 *
 * Exported so a screen composing a custom loading state out of multiple hook results (rather than
 * consuming one hook's own `loadingState`) can derive the same phase strings this package produces
 * internally, instead of hardcoding them.
 *
 * @param input Query, sync, and data-presence flags for one query/read.
 * @returns The current `LoadingPhase`.
 */
export declare const computePhase: (input: ComputePhaseInput) => LoadingPhase;
/**
 * Convert a loading phase plus data presence into UI display flags.
 *
 * @param phase Current loading phase from `computePhase`.
 * @param input Query, sync, and data-presence flags for one query/read.
 * @returns A normalized loading-state object for screens and lists.
 */
export declare const computeLoadingState: (phase: LoadingPhase, input: ComputePhaseInput) => LoadingState;
//# sourceMappingURL=loadingState.d.ts.map