import type { ModelDefinitions, ModelDefinitionsOptions } from '../types';
export declare const createModelDefinitions: <TStored extends {
    id: string;
    updatedAt?: string | null;
} & Record<string, unknown>, TInput>(options: ModelDefinitionsOptions<TStored, TInput>) => ModelDefinitions<TStored, TInput>;
//# sourceMappingURL=modelDefinitions.d.ts.map