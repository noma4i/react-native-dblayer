"use strict";

import { registerReset } from "../core/reset.js";
let validations = [];

/** Register a deferred definition check that runs during `bootDb` after every model has registered. */
export const registerBootValidation = validation => {
  validations.push(validation);
};

/** Run all deferred definition checks before journal replay starts. */
export const runBootValidations = () => {
  for (const validation of validations) validation();
};
registerReset(() => {
  validations = [];
});
//# sourceMappingURL=bootValidations.js.map
