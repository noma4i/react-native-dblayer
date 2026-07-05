"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.setDbModelDefaults = exports.getDbModelDefaults = void 0;
let dbModelDefaults = {};
const getDbModelDefaults = () => dbModelDefaults;
exports.getDbModelDefaults = getDbModelDefaults;
const setDbModelDefaults = defaults => {
  dbModelDefaults = defaults ?? {};
};
exports.setDbModelDefaults = setDbModelDefaults;
//# sourceMappingURL=modelDefaults.js.map