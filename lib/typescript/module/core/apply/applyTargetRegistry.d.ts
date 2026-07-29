import type { ApplyTarget } from '../../types';
/**
 * Register one model-owned application target for model application plans.
 *
 * A duplicate in one runtime generation throws; a later generation deliberately replaces the stale
 * target so recreated runtimes can reuse stable model ids.
 */
export declare const registerApplyTarget: (model: string, target: ApplyTarget) => (() => void);
export declare const getApplyTarget: (model: string) => ApplyTarget;
export declare const getApplyTargets: () => Array<[string, ApplyTarget]>;
//# sourceMappingURL=applyTargetRegistry.d.ts.map