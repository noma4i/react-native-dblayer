import type { WriteOp } from './core.apply.ops.types';
import type { InvalidationTarget } from './dsl.writePlan.types';
import type { ModelEventLifecycleEntry, ModelEventLifecycle, ModelEventRegistration } from './subscription.types';

export type StoredModelEventRegistration = {
  document: ModelEventRegistration<unknown>['document'];
  variables?: Record<string, unknown>;
  debounce?: ModelEventLifecycleEntry['debounce'];
  plan(payload: unknown): { writeOps: WriteOp[]; invalidations: InvalidationTarget[] };
  payloadKey: string;
};

export type ModelEventSlot = {
  identity: string;
  modelKey: string;
  eventName: string;
  generationFence: { isCurrent(): boolean; captureNow(): void };
  current: StoredModelEventRegistration;
  runtime: ModelEventLifecycle | null;
  owners: Set<symbol>;
  listeners: Set<(payload: unknown) => void>;
};
