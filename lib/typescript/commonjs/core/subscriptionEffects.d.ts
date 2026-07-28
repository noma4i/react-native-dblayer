import type { DbSubscriptionEffectsChannel } from '../types';
/** Resolve an injected subscription effect by its stable application name. */
export declare const getSubscriptionEffect: (name: string) => ((...args: never[]) => void) | undefined;
/** Create an injectable effects channel for subscription entries. */
export declare const createSubscriptionEffects: <TEffects extends Record<keyof TEffects, (...args: never[]) => void>>(noopEffects: TEffects) => DbSubscriptionEffectsChannel<TEffects>;
//# sourceMappingURL=subscriptionEffects.d.ts.map