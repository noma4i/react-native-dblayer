import type { ApplyTarget } from '../../types';
import { createGenerationRegistry } from '../generationRegistry';

const targets = createGenerationRegistry<ApplyTarget>();

/**
 * Register one model-owned application target for model application plans.
 *
 * A duplicate in one runtime generation throws; a later generation deliberately replaces the stale
 * target so recreated runtimes can reuse stable model ids.
 */
export const registerApplyTarget = (model: string, target: ApplyTarget): (() => void) => {
  return targets.register(model, target, `Apply target already registered for model ${model}`);
};

export const getApplyTarget = (model: string): ApplyTarget => {
  const target = targets.get(model);
  if (!target) throw new Error(`No apply target registered for ${model}`);
  return target;
};

export const getApplyTargets = (): Array<[string, ApplyTarget]> => [...targets.entries()];
