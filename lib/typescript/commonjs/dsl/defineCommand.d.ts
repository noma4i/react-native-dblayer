import { defineMutation } from './defineMutation';
import type { CommandConfig } from '../types';
/**
 * Define a model-less GraphQL command with a conventional input-sensitive in-flight guard. Commands use
 * the standard mutation runner and hook lifecycle but cannot perform an optimistic model write. Set
 * `once: true` to retain committed keys until reset, or `dedupe: false` to disable the guard.
 *
 * @param name Stable command namespace used by the default dedupe key.
 * @param config Mutation document, response result field, optional dedupe/once policy, mapping, response WritePlan, and lifecycle callbacks.
 * @returns The same `{ run, retry, discard, use }` surface as `defineMutation`.
 */
export declare const defineCommand: <TData, TInput, TStored extends {
    id: string;
} = {
    id: string;
}, TNode = TStored>(name: string, config: CommandConfig<TData, TInput, TStored, TNode>) => ReturnType<typeof defineMutation<TData, TInput, TStored, TNode>>;
//# sourceMappingURL=defineCommand.d.ts.map