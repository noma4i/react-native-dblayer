import type { ModelEventLifecycleEntry, ModelEventLifecycle } from '../types';
/** Create the activation, delivery, debounce, retry, and reset lifecycle for static subscription entries. */
export declare const createModelEventLifecycle: <TPayload = unknown>(entries: readonly ModelEventLifecycleEntry<TPayload>[]) => ModelEventLifecycle;
//# sourceMappingURL=subscriptionLifecycle.d.ts.map