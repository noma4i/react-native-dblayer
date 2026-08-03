import type { ModelEventRegistration, ModelEventSubscription } from '../types';
export declare const acquireModelSubscriptions: () => (() => void);
export declare const registerModelEvent: <TPayload>(registration: ModelEventRegistration<TPayload>) => ModelEventSubscription<TPayload>;
export declare const restartModelEventRegistry: () => void;
//# sourceMappingURL=modelEventRegistry.d.ts.map