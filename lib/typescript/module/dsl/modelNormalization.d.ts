import type { InferStoredFields, ModelConfig, ModelFieldSpecs, ModelNormalization } from '../types';
export declare const readModelField: (field: ModelFieldSpecs[string], input: unknown, key: string, complete: boolean) => unknown;
export declare const createModelNormalization: <TFields extends ModelFieldSpecs, TScopeNames extends string, TExt extends Record<string, unknown>>(config: ModelConfig<TFields, TScopeNames, TExt, any>) => ModelNormalization<InferStoredFields<TFields> & Record<string, unknown>>;
//# sourceMappingURL=modelNormalization.d.ts.map