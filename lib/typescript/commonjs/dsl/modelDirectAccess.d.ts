import type { ModelDirectAccess, ModelDirectAccessOptions } from '../types';
export declare const createModelDirectAccess: <TStored extends {
    id: string;
    updatedAt?: string | null;
} & Record<string, unknown>, TInput>(options: ModelDirectAccessOptions<TStored, TInput>) => ModelDirectAccess<TStored, TInput>;
//# sourceMappingURL=modelDirectAccess.d.ts.map