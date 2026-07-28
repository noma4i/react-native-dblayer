import { hasDependentCascade } from '../core/relations';
import { getInternalModelHandle, getInternalScopeHandle } from '../core/internalHandles';
import { registerBootValidation } from './bootValidations';
import type { DestroyOptimistic, MutationConfig, PatchOptimistic, RespondOptimistic } from '../types';

export const isMethodOptimistic = <TData, TInput, TStored, TNode>(
  value: NonNullable<MutationConfig<TData, TInput, TStored, TNode>['optimistic']>
): value is PatchOptimistic<TInput, TStored> | DestroyOptimistic<TInput> => 'method' in value;

export const isRespondOptimistic = <TData, TInput, TStored, TNode>(
  value: NonNullable<MutationConfig<TData, TInput, TStored, TNode>['optimistic']>
): value is RespondOptimistic<TData, TInput, TNode> => 'respond' in value;

export const validateMutationConfig = <TData, TInput, TStored, TNode>(config: MutationConfig<TData, TInput, TStored, TNode>): void => {
  if (config.once && config.dedupe === false) throw new Error('once cannot be combined with dedupe: false');
  const optimistic = config.optimistic;
  if (optimistic && isRespondOptimistic(optimistic) && (`build` in optimistic || `method` in optimistic)) {
    throw new Error('optimistic respond cannot be combined with build or method');
  }
  if (optimistic && isMethodOptimistic(optimistic) && (`prependTo` in optimistic || `appendTo` in optimistic)) {
    throw new Error('optimistic prependTo/appendTo requires an insert optimistic config');
  }
  if (optimistic && !isMethodOptimistic(optimistic) && !isRespondOptimistic(optimistic) && getInternalModelHandle(optimistic.model).dropTempRowsAfterMs() === undefined) {
    throw new Error(`${optimistic.model.modelId} must declare maintenance.dropTempRowsAfterMs to be used in an optimistic insert mutation`);
  }
  if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'destroy') {
    registerBootValidation(`optimistic-destroy-cascade:${optimistic.model.modelId}`, () => {
      if (hasDependentCascade(optimistic.model.modelId)) {
        throw new Error(`${optimistic.model.modelId}: optimistic destroy is not supported on models with dependent cascades - rollback cannot restore cascaded children`);
      }
    });
  }
  if (optimistic && !isMethodOptimistic(optimistic)) {
    if (optimistic.prependTo && optimistic.appendTo) throw new Error('optimistic prependTo and appendTo are mutually exclusive');
    const placement = optimistic.prependTo ?? optimistic.appendTo;
    if (placement && !getInternalScopeHandle(placement.scope).isServerOrder()) throw new Error('optimistic prependTo/appendTo requires a server-order scope');
    if (placement && placement.scope.modelId !== optimistic.model.modelId) throw new Error('optimistic prependTo/appendTo scope must belong to the optimistic model');
  }
};
