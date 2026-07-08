"use strict";

import { pickDefined } from "../utils/pickDefined.js";
import { getDbLogger } from "./logger.js";
import { runWithoutWritePropagation } from "./writePropagation.js";
const definedProjection = projection => pickDefined(projection, Object.keys(projection));
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
    getDbLogger().error(`[${sourceName}] mirror insert skipped`, {
      target: target.collection.id,
      id: rowId,
      error
    });
    return null;
  }
};
export const createMirrorPropagator = (sourceName, mirrors) => {
  if (!mirrors || mirrors.length === 0) return null;
  return row => {
    for (const mirror of mirrors) {
      const projected = mirror.project(row);
      if (projected === null) continue;
      const projection = definedProjection(projected);
      const target = mirror.model();
      runWithoutWritePropagation(() => {
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
//# sourceMappingURL=modelMirror.js.map