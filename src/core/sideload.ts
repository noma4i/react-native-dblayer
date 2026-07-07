import type { CollectionModel, SyncContract } from '../types';
import { mergeSyncContract } from '../utils/serverSync';
import { getRegisteredModel } from './modelRegistry';

export type SideloadSpec<TInput = unknown> = {
  /** Registry name of the target model. */
  model: string;
  /** Collect nested raw payloads from one input item. */
  pluck: (input: TInput) => unknown | unknown[] | null | undefined;
  /** Sync-contract source label. */
  source?: string;
};

const applyingModels = new Set<string>();

type SideloadTarget = Pick<CollectionModel<unknown, { id: string; updatedAt?: string | null }>, 'applyServerData'>;

const collectPayloads = (spec: SideloadSpec, items: unknown[]): unknown[] => {
  const payloads: unknown[] = [];

  for (const item of items) {
    const value = spec.pluck(item);
    const values = Array.isArray(value) ? value : [value];
    for (const payload of values) {
      if (payload != null) {
        payloads.push(payload);
      }
    }
  }

  return payloads;
};

export const isModelApplying = (name: string): boolean => applyingModels.has(name);

export const withApplyingModel = <T>(name: string, fn: () => T): T => {
  const alreadyApplying = applyingModels.has(name);
  if (!alreadyApplying) {
    applyingModels.add(name);
  }

  try {
    return fn();
  } finally {
    if (!alreadyApplying) {
      applyingModels.delete(name);
    }
  }
};

export const runSideloads = (specs: SideloadSpec[] | undefined, items: unknown[], parentContract: SyncContract): void => {
  if (!specs?.length || !items.length) return;

  for (const spec of specs) {
    if (isModelApplying(spec.model)) continue;

    const payloads = collectPayloads(spec, items);
    if (!payloads.length) continue;

    const target = getRegisteredModel(spec.model) as SideloadTarget;
    target.applyServerData(payloads, mergeSyncContract(spec.source ?? parentContract.source ?? 'sideload'));
  }
};
