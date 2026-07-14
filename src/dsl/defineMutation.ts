import { useCallback, useState } from 'react';
import type { DbGraphQLDocument } from '../types';
import { getDbRuntimeConfig } from './configure';

type MutationModel = {
  get(id: string): unknown;
  insertStored(row: { id: string }): void;
  patch(id: string, patch: Record<string, unknown>): void;
  destroy(id: string): void;
  replaceRaw(oldId: string, next: unknown): void;
};

export type OptimisticCtx = { tempId: string | null };

export type MutationConfig<TData, TInput, TStored, TNode> = {
  document: DbGraphQLDocument<TData, any>;
  result: string;
  mapInput?: (input: TInput) => Record<string, unknown>;
  optimistic?:
    | { model: MutationModel; tempIdPrefix?: string; build: (input: TInput, ctx: OptimisticCtx) => TStored; selectServerNode: (data: TData) => TNode | null | undefined; preserveOnCommit?: ReadonlyArray<keyof TStored> }
    | { method: 'patch'; model: MutationModel; selectId: (input: TInput) => string; selectPatch: (input: TInput) => Partial<TStored> }
    | { method: 'destroy'; model: MutationModel; selectId: (input: TInput) => string };
};

let nextTempSequence = 0;
const tempId = (prefix: string): string => `${prefix}:${++nextTempSequence}`;

const isMethodOptimistic = (value: unknown): value is { method: 'patch' | 'destroy'; model: MutationModel; selectId: (input: unknown) => string; selectPatch?: (input: unknown) => Record<string, unknown> } =>
  typeof value === 'object' && value !== null && 'method' in value;

/** Define hook and imperative mutation paths with identical transport execution. */
export const defineMutation = <TData, TInput, TStored extends { id: string }, TNode>(config: MutationConfig<TData, TInput, TStored, TNode>) => {
  const run = async (input: TInput): Promise<TData | null> => {
    const optimistic = config.optimistic as any;
    let insertedId: string | null = null;
    let previous: unknown = null;
    if (optimistic && !isMethodOptimistic(optimistic)) {
      insertedId = tempId(optimistic.tempIdPrefix ?? 'temp');
      const row = optimistic.build(input, { tempId: insertedId });
      optimistic.model.insertStored({ ...row, id: insertedId });
    } else if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'patch') {
      const id = optimistic.selectId(input);
      previous = optimistic.model.get(id);
      optimistic.model.patch(id, optimistic.selectPatch!(input) as Record<string, unknown>);
    } else if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'destroy') {
      const id = optimistic.selectId(input);
      previous = optimistic.model.get(id);
      optimistic.model.destroy(id);
    }
    try {
      const data = (await getDbRuntimeConfig().transport.mutation({ mutation: config.document, variables: { input: config.mapInput?.(input) ?? input } })).data;
      if (optimistic && !isMethodOptimistic(optimistic)) {
        const node = optimistic.selectServerNode(data);
        if (node != null && insertedId) optimistic.model.replaceRaw(insertedId, node);
      }
      return data;
    } catch (error) {
      if (optimistic && !isMethodOptimistic(optimistic) && insertedId) optimistic.model.destroy(insertedId);
      if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'patch' && previous && typeof previous === 'object') optimistic.model.patch(optimistic.selectId(input), previous as Record<string, unknown>);
      if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'destroy' && previous && typeof previous === 'object') optimistic.model.insertStored(previous as { id: string });
      throw error;
    }
  };
  return {
    run,
    use: () => {
      const [isPending, setPending] = useState(false);
      const [error, setError] = useState<Error | null>(null);
      const mutateAsync = useCallback(async (input: TInput) => {
        setPending(true);
        setError(null);
        try {
          return await run(input);
        } catch (nextError) {
          setError(nextError as Error);
          return null;
        } finally {
          setPending(false);
        }
      }, []);
      return { mutate: (input: TInput) => { void mutateAsync(input); }, mutateAsync, isPending, error };
    }
  };
};
