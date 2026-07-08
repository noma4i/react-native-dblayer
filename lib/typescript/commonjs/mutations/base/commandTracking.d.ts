import type { DbCommandMutationConfig } from '../../types';
export declare const emitCommandTrackStart: <TInput, TData, TExtractSpec>(config: DbCommandMutationConfig<TInput, TData, TExtractSpec>, input: TInput) => void;
export declare const emitCommandTrackSuccess: <TInput, TData, TExtractSpec>(config: DbCommandMutationConfig<TInput, TData, TExtractSpec>, result: TData | null, input: TInput) => void;
export declare const emitCommandTrackError: <TInput, TData, TExtractSpec>(config: DbCommandMutationConfig<TInput, TData, TExtractSpec>, error: Error, input: TInput) => void;
//# sourceMappingURL=commandTracking.d.ts.map