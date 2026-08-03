"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.modelRootIntentOf = exports.compileModelRootPlan = void 0;
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
const rootForms = ['insert', 'update', 'destroy'];
const rootFormOf = root => {
  if (!(0, _normalizeHelpers.isNonArrayRecord)(root)) throw new Error('ModelRootPlan must contain exactly one root form');
  const keys = Reflect.ownKeys(root);
  if (keys.length !== 1 || typeof keys[0] !== 'string' || !rootForms.includes(keys[0])) {
    throw new Error('ModelRootPlan must contain exactly one root form');
  }
  return keys[0];
};
const modelRootIntentOf = root => {
  const form = rootFormOf(root);
  if (form === 'insert') return 'insert';
  if (form === 'update') return 'patch';
  return 'destroy';
};
exports.modelRootIntentOf = modelRootIntentOf;
const asArray = value => Array.isArray(value) ? value : [value];
const normalizeRootId = (value, form) => {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`ModelRootPlan ${form} requires a non-empty id`);
  }
  const id = String(value);
  if (!(0, _normalizeHelpers.isNonEmptyString)(id)) throw new Error(`ModelRootPlan ${form} requires a non-empty id`);
  return id;
};
const compileModelRootPlan = (owner, root, context) => {
  const form = rootFormOf(root);
  if (form === 'insert' && 'insert' in root) {
    const insert = root.insert;
    if (!insert) throw new Error('ModelRootPlan must contain exactly one root form');
    const selected = insert.select(context);
    if (selected == null) return [];
    if (Array.isArray(selected) && selected.length === 0) return owner.planEmpty?.() ?? [];
    return owner.planRows(asArray(selected));
  }
  if (form === 'update' && 'update' in root) {
    const update = root.update;
    if (!update) throw new Error('ModelRootPlan must contain exactly one root form');
    const selected = update.select(context);
    if (selected == null || Array.isArray(selected) && selected.length === 0) return [];
    const updates = Array.isArray(selected) ? selected : [selected];
    const normalized = updates.map(update => {
      if (!(0, _normalizeHelpers.isNonArrayRecord)(update.patch)) throw new Error('ModelRootPlan update requires a plain object patch');
      if ('id' in update.patch) throw new Error('ModelRootPlan update patch cannot contain id');
      for (const [field, value] of Object.entries(update.patch)) {
        if (value === undefined) throw new Error(`ModelRootPlan update patch field "${field}" cannot be undefined`);
      }
      return {
        id: normalizeRootId(update.id, 'update'),
        patch: update.patch
      };
    });
    return normalized.map(update => ({
      kind: 'patch',
      model: owner.modelId,
      id: update.id,
      patch: update.patch
    }));
  }
  if (!('destroy' in root)) throw new Error('ModelRootPlan must contain exactly one root form');
  const destroy = root.destroy;
  if (!destroy) throw new Error('ModelRootPlan must contain exactly one root form');
  const selected = destroy.select(context);
  if (selected == null || Array.isArray(selected) && selected.length === 0) return [];
  const ids = Array.isArray(selected) ? selected : [selected];
  return [{
    kind: 'destroy',
    model: owner.modelId,
    ids: ids.map(id => normalizeRootId(id, 'destroy'))
  }];
};
exports.compileModelRootPlan = compileModelRootPlan;
//# sourceMappingURL=modelRootPlan.js.map