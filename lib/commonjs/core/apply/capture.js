"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.captureApplyState = void 0;
/** Capture causality before transport starts. */
const captureApplyState = (entityClock, scopeGeneration) => ({
  entityClock,
  scopeGeneration
});
exports.captureApplyState = captureApplyState;
//# sourceMappingURL=capture.js.map