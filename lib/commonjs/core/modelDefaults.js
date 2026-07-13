"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.setDbModelDefaults = exports.getDbModelDefaults = void 0;
var _configuredSlot = require("./configuredSlot.js");
const dbModelDefaults = (0, _configuredSlot.createConfiguredSlot)({});
const getDbModelDefaults = () => dbModelDefaults.get();
exports.getDbModelDefaults = getDbModelDefaults;
const setDbModelDefaults = defaults => {
  dbModelDefaults.set(defaults ?? {});
};
exports.setDbModelDefaults = setDbModelDefaults;
//# sourceMappingURL=modelDefaults.js.map