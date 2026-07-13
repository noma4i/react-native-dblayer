"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.runWithoutWritePropagation = exports.isWritePropagationActive = exports.createWritePropagation = void 0;
let explicitSuppressionDepth = 0;
let activeModels = null;
const isWritePropagationActive = () => activeModels !== null;
exports.isWritePropagationActive = isWritePropagationActive;
const runWithoutWritePropagation = fn => {
  explicitSuppressionDepth += 1;
  try {
    return fn();
  } finally {
    explicitSuppressionDepth = Math.max(0, explicitSuppressionDepth - 1);
  }
};
exports.runWithoutWritePropagation = runWithoutWritePropagation;
const createWritePropagation = modelName => {
  const propagators = [];
  return {
    register(propagator) {
      propagators.push(propagator);
    },
    announce(row, kind) {
      if (explicitSuppressionDepth > 0 || propagators.length === 0) return;
      const context = activeModels ?? new Set();
      if (context.has(modelName)) return;
      const isRoot = activeModels === null;
      if (isRoot) activeModels = context;
      context.add(modelName);
      try {
        for (const propagator of propagators) {
          propagator(row, kind);
        }
      } finally {
        if (isRoot) activeModels = null;
      }
    }
  };
};
exports.createWritePropagation = createWritePropagation;
//# sourceMappingURL=writePropagation.js.map