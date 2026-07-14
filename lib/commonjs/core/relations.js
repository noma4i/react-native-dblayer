"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.hasOne = exports.hasMany = exports.belongsTo = void 0;
/** Declare an inverse parent relation and optional derived parent updates. */
const belongsTo = (model, options) => ({
  kind: 'belongsTo',
  model: model,
  foreignKey: options.foreignKey,
  touch: options.touch,
  counterCache: options.counterCache
});

/** Declare a direct child relation whose cascade authority is explicit destroy only. */
exports.belongsTo = belongsTo;
const hasMany = (model, options) => ({
  kind: 'hasMany',
  model: model,
  foreignKey: options.foreignKey,
  dependent: options.dependent
});

/** Declare a query-only single child relation. */
exports.hasMany = hasMany;
const hasOne = (model, options) => ({
  kind: 'hasOne',
  model: model,
  foreignKey: options.foreignKey,
  comparator: options.comparator
});
exports.hasOne = hasOne;
//# sourceMappingURL=relations.js.map