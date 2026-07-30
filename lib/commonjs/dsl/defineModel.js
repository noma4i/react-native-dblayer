"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineModel = void 0;
var _defineModelFacade = require("./defineModelFacade.js");
/**
 * Define one class-like persistent model.
 *
 * @param key Stable model identity used by storage, dependencies, and diagnostics.
 * @param config Schema, associations, named relations, actions, sideloads, policies, and statics.
 * @returns A model singleton with local reads/writes, flat relations, and model-owned actions.
 */
const defineModel = (key, config) => (0, _defineModelFacade.defineModelFacade)(key, config);
exports.defineModel = defineModel;
//# sourceMappingURL=defineModel.js.map