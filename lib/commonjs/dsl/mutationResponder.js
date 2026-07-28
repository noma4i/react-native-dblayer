"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createMutationResponder = void 0;
var _internalHandles = require("../core/internalHandles.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
const createMutationResponder = config => {
  const planFromRespond = (data, context, optimistic, input) => {
    const payload = data?.[config.result];
    if (payload == null) throw new Error(`${config.result} returned no data`);
    const node = optimistic.selectServerNode(data);
    const ops = [];
    if (node != null) {
      const raw = node;
      const id = raw.id === '' || raw.id == null ? context.tempId : String(raw.id);
      const row = {
        ...raw,
        id
      };
      if (context.tempId && id !== context.tempId && optimistic.model.find(context.tempId) !== undefined) {
        ops.push(...(0, _internalHandles.getInternalModelHandle)(optimistic.model).planReplace(context.tempId, row));
      } else {
        ops.push(...(0, _internalHandles.getInternalModelHandle)(optimistic.model).planRows([row]));
      }
      const placement = optimistic.prependTo ?? optimistic.appendTo;
      if (placement && context.tempId && id === context.tempId) {
        ops.push(...(0, _internalHandles.getInternalScopeHandle)(placement.scope).planPlacement(placement.value(input), id, optimistic.prependTo ? 'prepend' : 'append'));
      }
    }
    for (const sink of config.extract?.({
      data
    }) ?? []) ops.push(...(0, _internalHandles.getInternalModelHandle)(sink.into).planRows(sink.rows));
    return ops;
  };
  const inverseFromRespond = (data, context, optimistic) => {
    const targets = [];
    const node = optimistic.selectServerNode(data);
    if (node) targets.push({
      model: optimistic.model,
      id: node.id === '' || node.id == null ? context.tempId : String(node.id)
    });
    for (const sink of config.extract?.({
      data
    }) ?? []) {
      const model = sink.into;
      for (const row of sink.rows) if ((0, _normalizeHelpers.isRecord)(row) && row.id != null) targets.push({
        model,
        id: String(row.id)
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
      const internal = (0, _internalHandles.getInternalModelHandle)(model);
      return internal.planRestore(previous, internal.captureMembership(id));
    });
  };
  return {
    planFromRespond,
    inverseFromRespond
  };
};
exports.createMutationResponder = createMutationResponder;
//# sourceMappingURL=mutationResponder.js.map