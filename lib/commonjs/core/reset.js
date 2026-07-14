"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.resetRuntime = exports.registerReset = void 0;
const resetters = new Set();

/** Register runtime state that must clear on logout and account changes. */
const registerReset = reset => {
  resetters.add(reset);
  return () => resetters.delete(reset);
};

/** Reset every registered v6 state plane. */
exports.registerReset = registerReset;
const resetRuntime = async () => {
  for (const reset of resetters) await reset();
};
exports.resetRuntime = resetRuntime;
//# sourceMappingURL=reset.js.map