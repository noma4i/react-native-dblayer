import { getInternalModelHandle, getInternalScopeHandle } from '../core/internalHandles';
import { isRecord } from '../utils/normalizeHelpers';
import type { MutationConfig, MutationModel, MutationResponder, OptimisticCtx, RespondOptimistic, WriteOp } from '../types';

export const createMutationResponder = <TData, TInput, TStored, TNode>(config: MutationConfig<TData, TInput, TStored, TNode>): MutationResponder<TData, TInput, TNode> => {
  const planFromRespond = (data: TData, context: OptimisticCtx, optimistic: RespondOptimistic<TData, TInput, TNode>, input: TInput): WriteOp[] => {
    const payload = (data as Record<string, unknown> | null | undefined)?.[config.result];
    if (payload == null) throw new Error(`${config.result} returned no data`);
    const node = optimistic.selectServerNode(data);
    const ops: WriteOp[] = [];
    if (node != null) {
      const raw = node as Record<string, unknown>;
      const id = raw.id === '' || raw.id == null ? context.tempId : String(raw.id);
      const row = { ...raw, id };
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
    for (const sink of config.extract?.({ data }) ?? []) ops.push(...getInternalModelHandle(sink.into).planRows(sink.rows));
    return ops;
  };

  const inverseFromRespond = (data: TData, context: OptimisticCtx, optimistic: RespondOptimistic<TData, TInput, TNode>): WriteOp[] => {
    const targets: Array<{ model: MutationModel; id: string }> = [];
    const node = optimistic.selectServerNode(data) as Record<string, unknown> | null | undefined;
    if (node) targets.push({ model: optimistic.model, id: node.id === '' || node.id == null ? context.tempId! : String(node.id) });
    for (const sink of config.extract?.({ data }) ?? []) {
      const model = sink.into as MutationModel;
      for (const row of sink.rows) if (isRecord(row) && row.id != null) targets.push({ model, id: String(row.id) });
    }
    return targets.flatMap(({ model, id }) => {
      const previous = model.find(id);
      if (previous === undefined) return [{ kind: 'destroy' as const, model: model.modelId, ids: [id], tombstone: false }];
      const internal = getInternalModelHandle(model);
      return internal.planRestore(previous, internal.captureMembership(id));
    });
  };

  return { planFromRespond, inverseFromRespond };
};
