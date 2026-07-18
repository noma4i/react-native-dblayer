import { buildScopeKey } from '../core/compileDbWhere';
import { defineMutation, type MutationConfig } from './defineMutation';

type CommandConfig<TData, TInput, TStored extends { id: string }, TNode> = Omit<MutationConfig<TData, TInput, TStored, TNode>, 'dedupe' | 'optimistic'> & { dedupe?: false | MutationConfig<TData, TInput, TStored, TNode>['dedupe'] };

/**
 * Define a model-less GraphQL command with conventional input-sensitive deduplication. Commands use the
 * standard mutation runner and hook lifecycle but cannot perform an optimistic model write.
 *
 * @param name Stable command namespace used by the default dedupe key.
 * @param config Mutation document, response result field, optional mapping/extract, and lifecycle callbacks.
 * @returns The same `{ run, use }` surface as `defineMutation`.
 */
export const defineCommand = <TData, TInput, TStored extends { id: string } = { id: string }, TNode = TStored>(name: string, config: CommandConfig<TData, TInput, TStored, TNode>) => {
  const dedupe = config.dedupe === false ? undefined : config.dedupe ?? { key: input => `${name}:${buildScopeKey(input)}` };
  return defineMutation({ ...config, dedupe });
};
