"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createApplyPlan = void 0;
/** Build a side-effect-free plan before opening an in-memory transaction. */
const createApplyPlan = ops => ({
  ops,
  hash: JSON.stringify(ops)
});
exports.createApplyPlan = createApplyPlan;
//# sourceMappingURL=plan.js.map