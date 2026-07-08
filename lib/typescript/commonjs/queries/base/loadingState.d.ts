import type { ComputePhaseInput, LoadingPhase, LoadingState } from '../../types';
export declare const computePhase: (input: ComputePhaseInput) => LoadingPhase;
/**
 * Convert a loading phase plus data presence into UI display flags.
 *
 * @param phase Current loading phase from `computePhase`.
 * @param hasData Whether local or remote data is currently available.
 * @returns A normalized loading-state object for screens and lists.
 */
export declare const computeLoadingState: (phase: LoadingPhase, hasData: boolean) => LoadingState;
//# sourceMappingURL=loadingState.d.ts.map