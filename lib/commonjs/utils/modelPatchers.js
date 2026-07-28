"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createNestedObjectPatcher = exports.createKeyedArrayPatcher = exports.createIdArrayPatcher = void 0;
var _shape = require("../schema/shape.js");
var _normalizeHelpers = require("./normalizeHelpers.js");
/**
 * Create immutable patch helpers for an array of keyed shape sub-rows.
 *
 * @param shape Shape used to normalize incoming sub-rows.
 * @param options Key field used for replacement/removal.
 * @returns Immutable `upsert` and `remove` helpers for nullable arrays.
 */
const createKeyedArrayPatcher = (shape, options) => ({
  upsert(rows, input) {
    const next = (0, _shape.readShapeOrThrow)(shape, input, 'Keyed array patch item');
    const keyValue = next[options.key];
    return [...(rows ?? []).filter(entry => entry[options.key] !== keyValue), next];
  },
  remove(rows, keyValue) {
    return (rows ?? []).filter(entry => entry[options.key] !== keyValue);
  }
});

/**
 * Create immutable patch helpers for id arrays.
 *
 * @returns Immutable `upsert` and `remove` helpers that tolerate nullish arrays.
 */
exports.createKeyedArrayPatcher = createKeyedArrayPatcher;
const createIdArrayPatcher = () => ({
  upsert(ids, id, position) {
    const next = (ids ?? []).filter(existingId => existingId !== id);
    return position === 'prepend' ? [id, ...next] : [...next, id];
  },
  remove(ids, id) {
    return (ids ?? []).filter(existingId => existingId !== id);
  }
});

/**
 * Create a shallow patcher for a nullable nested object field.
 *
 * @param model Model used to read and patch the containing row.
 * @param field Nested object field to patch.
 * @param transform Function that derives a partial nested update from the current nested value and caller args.
 * @returns A patcher that returns `false` when the row or nested object is missing.
 */
exports.createIdArrayPatcher = createIdArrayPatcher;
const createNestedObjectPatcher = (model, field, transform) => {
  return (id, ...args) => {
    const row = model.find(id);
    const current = row?.[field];
    if (!(0, _normalizeHelpers.isRecord)(current)) return false;
    model.update(id, {
      [field]: {
        ...current,
        ...transform(current, ...args)
      }
    });
    return true;
  };
};
exports.createNestedObjectPatcher = createNestedObjectPatcher;
//# sourceMappingURL=modelPatchers.js.map