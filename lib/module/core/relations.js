"use strict";

/** Declare an inverse parent relation and optional derived parent updates. */
export const belongsTo = (model, options) => ({
  kind: 'belongsTo',
  model: model,
  foreignKey: options.foreignKey,
  touch: options.touch,
  counterCache: options.counterCache
});

/** Declare a direct child relation whose cascade authority is explicit destroy only. */
export const hasMany = (model, options) => ({
  kind: 'hasMany',
  model: model,
  foreignKey: options.foreignKey,
  dependent: options.dependent
});

/** Declare a query-only single child relation. */
export const hasOne = (model, options) => ({
  kind: 'hasOne',
  model: model,
  foreignKey: options.foreignKey,
  comparator: options.comparator
});
//# sourceMappingURL=relations.js.map