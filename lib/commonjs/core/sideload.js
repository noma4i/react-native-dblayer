"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.withApplyingModel = exports.runSideloads = exports.isModelApplying = void 0;
var _serverSync = require("../utils/serverSync.js");
var _modelRegistry = require("./modelRegistry.js");
const applyingModels = new Set();
const collectPayloads = (spec, items) => {
  const payloads = [];
  for (const item of items) {
    const value = spec.pluck(item);
    const values = Array.isArray(value) ? value : [value];
    for (const payload of values) {
      if (payload != null) {
        payloads.push(payload);
      }
    }
  }
  return payloads;
};
const isModelApplying = name => applyingModels.has(name);
exports.isModelApplying = isModelApplying;
const withApplyingModel = (name, fn) => {
  const alreadyApplying = applyingModels.has(name);
  if (!alreadyApplying) {
    applyingModels.add(name);
  }
  try {
    return fn();
  } finally {
    if (!alreadyApplying) {
      applyingModels.delete(name);
    }
  }
};
exports.withApplyingModel = withApplyingModel;
const runSideloads = (specs, items, parentContract) => {
  if (!specs?.length || !items.length) return;
  for (const spec of specs) {
    if (isModelApplying(spec.model)) continue;
    const payloads = collectPayloads(spec, items);
    if (!payloads.length) continue;
    const target = (0, _modelRegistry.getRegisteredModel)(spec.model);
    target.applyServerData(payloads, (0, _serverSync.mergeSyncContract)(spec.source ?? parentContract.source ?? 'sideload'));
  }
};
exports.runSideloads = runSideloads;
//# sourceMappingURL=sideload.js.map