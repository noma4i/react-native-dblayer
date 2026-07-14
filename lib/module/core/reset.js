"use strict";

const resetters = new Set();

/** Register runtime state that must clear on logout and account changes. */
export const registerReset = reset => {
  resetters.add(reset);
  return () => resetters.delete(reset);
};

/** Reset every registered v6 state plane. */
export const resetRuntime = async () => {
  for (const reset of resetters) await reset();
};
//# sourceMappingURL=reset.js.map