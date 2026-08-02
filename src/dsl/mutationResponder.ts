import { getInternalModelHandle, getInternalScopeHandle } from '../core/internalHandles';
import type { MutationConfig, MutationModel, MutationResponder, OptimisticCtx, RespondOptimistic, WriteOp } from '../types';

const normalizeResponseId = (model: MutationModel, row: Record<string, unknown>, fallbackId?: string | null): string => {
  const internal = getInternalModelHandle(model);
  try {
    return internal.normalizeRowId(row);
  } catch (error) {
    if (!fallbackId || (row.id !== '' && row.id != null)) throw error;
    return internal.normalizeRowId({ ...row, id: fallbackId });
  }
};

export const createMutationResponder = <TData, TInput, TStored, TNode>(config: MutationConfig<TData, TInput, TStored, TNode>): MutationResponder<TData, TInput, TNode> => {
  const planFromRespond = (data: TData, context: OptimisticCtx, optimistic: RespondOptimistic<TData, TInput, TNode>, input: TInput): WriteOp[] => {
    const payload = (data as Record<string, unknown> | null | undefined)?.[config.result];
    if (payload == null) throw new Error(`${config.result} returned no data`);
    const node = optimistic.selectServerNode(data);
    const ops: WriteOp[] = [];
    if (node != null) {
      const raw = node as Record<string, unknown>;
      const id = normalizeResponseId(optimistic.model, raw, context.tempId);
      const row = raw.id === '' || raw.id == null ? { ...raw, id } : raw;
      if (context.tempId && id !== context.tempId && optimistic.model.find(context.tempId) !== undefined) {
        ops.push(...getInternalModelHandle(optimistic.model).planReplace(context.tempId, row));
      } else {
        ops.push(...getInternalModelHandle(optimistic.model).planRows([row]));
      }
      const placement = optimistic.prependTo ?? optimistic.appendTo;
      if (placement && context.tempId && id === context.tempId) {
        ops.push(...getInternalScopeHandle(placement.scope).planPlacement(placement.value(input), id, optimistic.prependTo ? 'prepend' : 'append'));
      }
    }
    return ops;
  };

  const inverseFromRespond = (data: TData, context: OptimisticCtx, optimistic: RespondOptimistic<TData, TInput, TNode>): WriteOp[] => {
    const targets: Array<{ model: MutationModel; id: string }> = [];
    const node = optimistic.selectServerNode(data) as Record<string, unknown> | null | undefined;
    if (node) targets.push({ model: optimistic.model, id: normalizeResponseId(optimistic.model, node, context.tempId) });
    return targets.flatMap(({ model, id }) => {
      const previous = model.find(id);
      if (previous === undefined) return [{ kind: 'destroy' as const, model: model.modelId, ids: [id], tombstone: false }];
      const internal = getInternalModelHandle(model);
      return internal.planRestore(previous, internal.captureMembership(id));
    });
  };

  return { planFromRespond, inverseFromRespond };
};
