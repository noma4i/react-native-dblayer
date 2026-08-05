"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.runBootValidations = exports.registerBootValidation = void 0;
/**
 * Definition registry: validations are declared by `define*` calls at app-module load and outlive
 * `resetRuntime` - the next boot re-runs every declared check. Registering the same key REPLACES
 * the previous validation, so redefining a declaration never accumulates duplicates.
 */
const validations = new Map();

/**
 * Register a deferred definition check that runs during `bootDb` after every model has registered.
 * @param key Stable definition identity; re-registration replaces the previous validation.
 * @param validation Check to run on every boot; throw to fail the boot.
 */
const registerBootValidation = (key, validation) => {
  validations.set(key, validation);
};

/** Run all deferred definition checks before the boot fsck starts. */
exports.registerBootValidation = registerBootValidation;
const runBootValidations = () => {
  for (const validation of validations.values()) validation();
};
exports.runBootValidations = runBootValidations;
//# sourceMappingURL=bootValidations.js.map