"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.modelDetailRequest = void 0;
var _deriveDbKey = require("../../core/deriveDbKey.js");
const resolveDetailId = id => typeof id === 'function' ? id() : id;
const resolveDetailVars = (id, vars) => {
  if (typeof vars === 'function') return vars(id);
  if (vars !== undefined) return vars;
  return {
    id
  };
};
const resolveDetailEnabled = (id, enabled) => {
  const idEnabled = Boolean(id);
  if (enabled === undefined) return idEnabled;
  if (typeof enabled === 'function') return idEnabled && enabled(id);
  return idEnabled && enabled;
};

/**
 * Build a model-backed detail request config with derived key, vars, sync, read, and enabled fields.
 */
const modelDetailRequest = (model, config) => {
  const id = resolveDetailId(config.id);
  const readEnabled = config.read !== false;
  return {
    query: config.query,
    key: config.key ?? (0, _deriveDbKey.deriveDbKey)(model, id ? {
      id
    } : undefined),
    select: config.select,
    vars: resolveDetailVars(id, config.vars),
    sync: {
      model,
      contract: config.contract ?? 'detail'
    },
    ...(config.map ? {
      map: config.map
    } : {}),
    ...(config.extract ? {
      extract: config.extract
    } : {}),
    ...(readEnabled ? {
      read: {
        model,
        id
      }
    } : {}),
    enabled: resolveDetailEnabled(id, config.enabled),
    inactive: config.inactive,
    staleTime: config.staleTime,
    gcTime: config.gcTime,
    refetchOnMount: config.refetchOnMount
  };
};
exports.modelDetailRequest = modelDetailRequest;
//# sourceMappingURL=modelDetailRequest.js.map