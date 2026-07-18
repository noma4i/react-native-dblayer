"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.runBootValidations = exports.registerBootValidation = void 0;
var _reset = require("../core/reset.js");
let validations = [];

/** Register a deferred definition check that runs during `bootDb` after every model has registered. */
const registerBootValidation = validation => {
  validations.push(validation);
};

/** Run all deferred definition checks before journal replay starts. */
exports.registerBootValidation = registerBootValidation;
const runBootValidations = () => {
  for (const validation of validations) validation();
};
exports.runBootValidations = runBootValidations;
(0, _reset.registerReset)(() => {
  validations = [];
});
//# sourceMappingURL=bootValidations.js.map
