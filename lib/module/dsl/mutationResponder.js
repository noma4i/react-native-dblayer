"use strict";

import { getInternalModelHandle, getInternalScopeHandle } from "../core/internalHandles.js";
import { isRecord } from "../utils/normalizeHelpers.js";
const normalizeResponseId = (model, row, fallbackId) => {
  const internal = getInternalModelHandle(model);
  try {
    return internal.normalizeRowId(row);
  } catch (error) {
    if (!fallbackId || row.id !== '' && row.id != null) throw error;
    return internal.normalizeRowId({
      ...row,
      id: fallbackId
    });
  }
};
export const createMutationResponder = config => {
  const planFromRespond = (data, context, optimistic, input) => {
    const payload = data?.[config.result];
    if (payload == null) throw new Error(`${config.result} returned no data`);
    const node = optimistic.selectServerNode(data);
    const ops = [];
    if (node != null) {
      const raw = node;
      const id = normalizeResponseId(optimistic.model, raw, context.tempId);
      const row = raw.id === '' || raw.id == null ? {
        ...raw,
        id
      } : raw;
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
    for (const sink of config.extract?.({
      data
    }) ?? []) ops.push(...getInternalModelHandle(sink.into).planRows(sink.rows));
    return ops;
  };
  const inverseFromRespond = (data, context, optimistic) => {
    const targets = [];
    const node = optimistic.selectServerNode(data);
    if (node) targets.push({
      model: optimistic.model,
      id: normalizeResponseId(optimistic.model, node, context.tempId)
    });
    for (const sink of config.extract?.({
      data
    }) ?? []) {
      const model = sink.into;
      for (const row of sink.rows) if (isRecord(row)) targets.push({
        model,
        id: normalizeResponseId(model, row)
      });
    }
    return targets.flatMap(({
      model,
      id
    }) => {
      const previous = model.find(id);
      if (previous === undefined) return [{
        kind: 'destroy',
        model: model.modelId,
        ids: [id],
        tombstone: false
      }];
      const internal = getInternalModelHandle(model);
      return internal.planRestore(previous, internal.captureMembership(id));
    });
  };
  return {
    planFromRespond,
    inverseFromRespond
  };
};
//# sourceMappingURL=mutationResponder.js.map