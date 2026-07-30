"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineModel = defineModel;
var _defineModelFacade = require("./defineModelFacade.js");
var _defineModelRuntime = require("./defineModelRuntime.js");
/**
 * Define one class-like persistent model.
 *
 * @param key Stable model identity used by storage, dependencies, and diagnostics.
 * @param config Schema, associations, named relations, actions, sideloads, policies, and statics.
 * @returns A model singleton with local reads/writes, flat relations, and model-owned actions.
 */

function defineModel(first, second) {
  return typeof first === 'string' ? (0, _defineModelFacade.defineModelFacade)(first, second) : (0, _defineModelRuntime.defineModelRuntime)(first);
}
//# sourceMappingURL=defineModel.js.map