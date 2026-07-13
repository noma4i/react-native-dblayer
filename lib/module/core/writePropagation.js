"use strict";

let explicitSuppressionDepth = 0;
let activeModels = null;
export const isWritePropagationActive = () => activeModels !== null;
export const runWithoutWritePropagation = fn => {
  explicitSuppressionDepth += 1;
  try {
    return fn();
  } finally {
    explicitSuppressionDepth = Math.max(0, explicitSuppressionDepth - 1);
  }
};
export const createWritePropagation = modelName => {
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
//# sourceMappingURL=writePropagation.js.map