import type { DbSubscriptionEntry, DbSubscriptionRuntime } from '../types';
/** Create the activation, delivery, debounce, retry, and reset lifecycle for static subscription entries. */
export declare const createSubscriptionLifecycle: <TPayload = unknown>(entries: readonly DbSubscriptionEntry<TPayload>[]) => DbSubscriptionRuntime;
//# sourceMappingURL=subscriptionLifecycle.d.ts.map