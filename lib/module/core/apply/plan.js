"use strict";

/** Build a side-effect-free plan before opening an in-memory transaction. */
export const createApplyPlan = ops => ({
  ops,
  hash: JSON.stringify(ops)
});
//# sourceMappingURL=plan.js.map