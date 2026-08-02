import { useEffect } from 'react';
import type { ActionInput, ActionPayload, FacadeRuntimeModel, GraphqlActionDefinition, ModelActionMethods, RowOperation } from '../types';
import { readRowOperationState, useRowOperationState } from './rowOperationState';
import { scalarFieldCodecs } from '../schema/fieldCodec';
import { exactMutationVariables } from './mutationVariables';
import { exactMutationRootPlan } from './mutationRootPlan';
import { getInternalModelHandle } from '../core/internalHandles';

/**
 * A declared action becomes its runtime handle here. The declared mode decides which machinery
 * carries it - a durable operation, a poller, or a mutation - and the caller sees one handle either
 * way, so a consumer never reproduces the lifecycle of the mode it happened to get.
 */
export const createOperation = <TStored extends { id: string; updatedAt?: string | null }, TInput>(
  runtime: FacadeRuntimeModel<TStored, TInput>,
  id: string | null | undefined
): RowOperation<TStored> => ({
  read: () => readRowOperationState<TStored>(runtime.modelId, id),
  use: () => useRowOperationState<TStored>(runtime.modelId, id)
});

export const createAction = <TStored extends { id: string; updatedAt?: string | null }, TInput, TDefinition extends GraphqlActionDefinition<any, any, any, any, any>>(
  runtime: FacadeRuntimeModel<TStored, TInput>,
  name: string,
  definition: TDefinition
): ModelActionMethods<Record<'defined', TDefinition>>['defined'] => {
  const readActionId = (value: unknown): string => {
    const id = scalarFieldCodecs.id.read(value);
    if (id === undefined) throw new Error(`${name}: action requires id`);
    return id;
  };
  if (definition.mode === 'durable') {
    if (!definition.optimistic) throw new Error(`${name}: durable insert requires optimistic build`);
    const insert = definition.optimistic;
    const handle = runtime.detached<ActionInput<TDefinition>>(name, {
      build: (input, context) => insert.build(input, context) as TStored,
      resume: definition.resume,
      failure: insert.failure,
      onFailurePatch: insert.onFailurePatch ? input => insert.onFailurePatch!(input) as Partial<TStored> : undefined
    });
    return {
      run: handle.start,
      complete: handle.complete,
      fail: handle.fail,
      retry: handle.retry,
      discard: handle.discard
    } as ModelActionMethods<Record<'defined', TDefinition>>['defined'];
  }
  if (definition.mode === 'poll') {
    const inputs = new Map<string, ActionInput<TDefinition>>();
    const refs = new Map<string, number>();
    const poller = runtime.poller<Parameters<typeof definition.select>[0]>(name, {
      document: definition.document,
      vars: id => {
        return definition.variables(inputs.get(id)!, { tempId: null, operationId: '' });
      },
      apply: (id, data) => {
        const patch = definition.select(data);
        if (patch != null) runtime.update(id, patch as Partial<TStored>);
      },
      classify: definition.poll.classify,
      intervalMs: definition.poll.intervalMs,
      maxAttempts: definition.poll.maxAttempts
    });
    const idFor = (input: ActionInput<TDefinition>): string => readActionId(definition.id(input));
    const retain = (id: string): void => {
      refs.set(id, (refs.get(id) ?? 0) + 1);
    };
    const release = (id: string): void => {
      const next = refs.get(id)! - 1;
      if (next > 0) {
        refs.set(id, next);
        return;
      }
      refs.delete(id);
      inputs.delete(id);
    };
    return {
      run: async (input: ActionInput<TDefinition>) => {
        const id = idFor(input);
        inputs.set(id, input);
        try {
          await poller.refresh(id);
        } finally {
          if (!refs.has(id)) inputs.delete(id);
        }
      },
      use: (input: ActionInput<TDefinition> | null) => {
        const id = input == null ? null : idFor(input);
        if (id) inputs.set(id, input!);
        const phase = poller.usePhase(id ?? `${name}:inactive`);
        useEffect(() => {
          if (!id) return;
          retain(id);
          const detach = poller.attach(id);
          return () => {
            detach();
            release(id);
          };
        }, [id]);
        return {
          ...(id ? phase : { phase: 'idle' as const, attempts: 0 }),
          refresh: async () => {
            if (!id || input == null) return;
            inputs.set(id, input);
            await poller.refresh(id, { resetBudget: true });
          }
        };
      }
    } as ModelActionMethods<Record<'defined', TDefinition>>['defined'];
  }
  const optimistic = (() => {
    if (definition.kind === 'insert' && definition.optimistic) {
      const insert = definition.optimistic;
      return {
        model: runtime,
        build: (input: Parameters<TDefinition['variables']>[0], context: { tempId: string | null; operationId: string }) => {
          return insert.build(input, { ...context, tempId: context.tempId! });
        },
        selectServerNode: definition.select,
        existingTempId: insert.existingTempId,
        failure: insert.failure,
        onFailurePatch: insert.onFailurePatch,
        onRetryPatch: insert.onRetryPatch,
        correlate: insert.correlate
      };
    }
    if (definition.kind === 'update' && definition.optimistic) {
      return {
        method: 'patch' as const,
        model: runtime,
        selectId: (input: ActionInput<TDefinition>) => readActionId(definition.id(input)),
        selectPatch: definition.optimistic.patch
      };
    }
    if (definition.kind === 'destroy' && definition.optimistic === true) {
      return {
        method: 'destroy' as const,
        model: runtime,
        selectId: (input: ActionInput<TDefinition>) => readActionId(definition.id(input))
      };
    }
    return undefined;
  })();
  const rootPlanner =
    definition.kind === 'update' || (definition.kind === 'insert' && !definition.optimistic)
      ? ({ data }: { data: Parameters<typeof definition.select>[0] }) => {
          const row = definition.select(data);
          return row == null ? [] : getInternalModelHandle(runtime).planRows([row]);
        }
      : definition.kind === 'custom' && definition.select
        ? (() => {
            const select = definition.select;
            return ({ data }: { data: Parameters<typeof select>[0] }) => {
              const row = select(data);
              return row == null ? [] : getInternalModelHandle(runtime).planRows([row]);
            };
          })()
        : undefined;
  const mutationConfig = {
    document: definition.document,
    result: definition.result,
    [exactMutationVariables]: definition.variables,
    optimistic,
    [exactMutationRootPlan]: rootPlanner,
    write: definition.write,
    dedupe: definition.dedupe,
    once: definition.once,
    onMutate: definition.before,
    onError: definition.error,
    track: definition.track
  };
  const mutation = runtime.mutation(name, mutationConfig);
  return {
    run: (input: ActionInput<TDefinition>) => mutation.run(input) as Promise<ActionPayload<TDefinition> | null>,
    retry: tempId => mutation.retry(tempId) as Promise<ActionPayload<TDefinition> | null>,
    discard: tempId => mutation.discard(tempId),
    use: () => {
      const handle = mutation.use();
      return {
        run: (input: ActionInput<TDefinition>) => handle.mutateAsync(input) as Promise<ActionPayload<TDefinition> | null>,
        isPending: handle.isPending,
        error: handle.error
      };
    }
  } as ModelActionMethods<Record<'defined', TDefinition>>['defined'];
};
