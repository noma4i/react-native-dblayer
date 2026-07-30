"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createModelDirectAccess = void 0;
var _invalidationRegistry = require("../core/invalidationRegistry.js");
var _incrementalReadEngine = require("../read/incrementalReadEngine.js");
const createModelDirectAccess = options => {
  const {
    planes
  } = options.context;
  return {
    find: id => id == null ? undefined : planes().entityState.read(String(id)),
    where: (where, readOptions) => {
      const rows = planes().entityState.values().filter(row => options.matchesCriteria(row, where));
      const order = readOptions?.orderBy ?? options.defaultOrder;
      if (!order) return (0, _incrementalReadEngine.limitRows)(rows, readOptions?.limit);
      return (0, _incrementalReadEngine.sortModelReadRows)(rows, [{
        field: String(order.field),
        direction: order.direction
      }], readOptions?.limit);
    },
    all: () => planes().entityState.values(),
    update: (id, patch) => options.applyEvent([{
      kind: 'patch',
      model: options.modelId,
      id: String(id),
      patch: patch
    }]),
    destroy: id => options.applyEvent([{
      kind: 'destroy',
      model: options.modelId,
      ids: [String(id)]
    }]),
    destroyMany: ids => options.applyEvent([{
      kind: 'destroy',
      model: options.modelId,
      ids: ids.map(id => String(id))
    }]),
    updateAll: (where, patch) => {
      const rows = planes().entityState.values().filter(row => options.matchesCriteria(row, where));
      if (rows.length === 0) return 0;
      options.applyEvent(rows.map(row => ({
        kind: 'patch',
        model: options.modelId,
        id: String(row.id),
        patch: patch
      })));
      return rows.length;
    },
    destroyAll: where => {
      const ids = planes().entityState.values().filter(row => options.matchesCriteria(row, where)).map(row => String(row.id));
      if (ids.length === 0) return 0;
      options.applyEvent([{
        kind: 'destroy',
        model: options.modelId,
        ids
      }]);
      return ids.length;
    },
    insert: row => options.applyEvent(options.planRows([row])),
    insertMany: rows => options.applyEvent(options.planRows(rows)),
    seed: rows => options.applyEvent(options.planRows(rows)),
    replace: (oldId, next) => options.applyEvent(options.planReplace(String(oldId), next)),
    build: input => options.normalize(input, true),
    normalize: input => options.normalize(input),
    invalidate: scope => {
      (0, _invalidationRegistry.invalidateModel)(options.modelId, scope);
    }
  };
};
exports.createModelDirectAccess = createModelDirectAccess;
//# sourceMappingURL=modelDirectAccess.js.map