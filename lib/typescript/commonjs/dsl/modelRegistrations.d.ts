import type { ModelRuntimeRegistrationOptions, ModelSchemaRegistrationOptions } from '../types';
export declare const registerModelSchema: <TStored extends {
    id: string;
} & Record<string, unknown>>(options: ModelSchemaRegistrationOptions<TStored>) => void;
export declare const registerModelRuntime: <TStored extends {
    id: string;
    updatedAt?: string | null;
} & Record<string, unknown>, TInput>(options: ModelRuntimeRegistrationOptions<TStored, TInput>) => void;
//# sourceMappingURL=modelRegistrations.d.ts.map