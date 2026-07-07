"use strict";

import { mergeSyncContract } from "../utils/serverSync.js";
import { getRegisteredModel } from "./modelRegistry.js";
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
export const isModelApplying = name => applyingModels.has(name);
export const withApplyingModel = (name, fn) => {
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
export const runSideloads = (specs, items, parentContract) => {
  if (!specs?.length || !items.length) return;
  for (const spec of specs) {
    if (isModelApplying(spec.model)) continue;
    const payloads = collectPayloads(spec, items);
    if (!payloads.length) continue;
    const target = getRegisteredModel(spec.model);
    target.applyServerData(payloads, mergeSyncContract(spec.source ?? parentContract.source ?? 'sideload'));
  }
};
//# sourceMappingURL=sideload.js.map