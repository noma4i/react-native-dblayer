"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createMirrorPropagator = void 0;
var _pickDefined = require("../utils/pickDefined.js");
var _logger = require("./logger.js");
var _writePropagation = require("./writePropagation.js");
const definedProjection = projection => (0, _pickDefined.pickDefined)(projection, Object.keys(projection));
const buildMirrorInsert = (sourceName, target, rowId, projection) => {
  const payload = {
    ...projection,
    id: rowId
  };
  if (typeof target.buildStored !== 'function') {
    return payload;
  }
  try {
    return target.buildStored(payload);
  } catch (error) {
    (0, _logger.getDbLogger)().error(`[${sourceName}] mirror insert skipped`, {
      target: target.collection.id,
      id: rowId,
      error
    });
    return null;
  }
};
const createMirrorPropagator = (sourceName, mirrors) => {
  if (!mirrors || mirrors.length === 0) return null;
  return row => {
    for (const mirror of mirrors) {
      const projected = mirror.project(row);
      if (projected === null) continue;
      const projection = definedProjection(projected);
      const target = mirror.model();
      (0, _writePropagation.runWithoutWritePropagation)(() => {
        if (target.get(row.id)) {
          target.patch(row.id, {
            ...projection,
            id: row.id
          });
          return;
        }
        const insertRow = buildMirrorInsert(sourceName, target, row.id, projection);
        if (insertRow) {
          target.insertStored(insertRow);
        }
      });
    }
  };
};
exports.createMirrorPropagator = createMirrorPropagator;
//# sourceMappingURL=modelMirror.js.map