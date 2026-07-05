"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createPatchCrud = createPatchCrud;
var _invariants = require("./invariants.js");
/** Create patch and destroy helpers for a collection. */
function createPatchCrud(config) {
  const patch = (id, updates) => {
    if (!config.collection.has(id)) return false;
    const existing = config.collection.get(id);
    if (!existing) return false;
    const updateRecord = updates;
    // Patch keeps partial update semantics: undefined incoming fields do not count as changes.
    if (!(0, _invariants.shouldAcceptIncoming)(existing, updateRecord, {
      timestampMode: 'when-both-present',
      equalityMode: 'defined-fields'
    })) return false;
    config.collection.update(id, draft => {
      const draftRecord = draft;
      for (const key of Object.keys(updateRecord)) {
        const value = updateRecord[key];
        if (value !== undefined) {
          draftRecord[key] = value;
        }
      }
    });
    return true;
  };
  const destroy = id => {
    if (!config.collection.has(id)) return false;
    config.collection.delete(id);
    return true;
  };
  return {
    patch,
    destroy
  };
}
//# sourceMappingURL=createPatchCrud.js.map