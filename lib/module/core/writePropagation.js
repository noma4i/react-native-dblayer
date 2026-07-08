"use strict";

let propagationDepth = 0;
export const isWritePropagationActive = () => propagationDepth > 0;
export const runWithoutWritePropagation = fn => {
  propagationDepth += 1;
  try {
    return fn();
  } finally {
    propagationDepth = Math.max(0, propagationDepth - 1);
  }
};
export const createWritePropagation = () => {
  const propagators = [];
  return {
    register(propagator) {
      propagators.push(propagator);
    },
    announce(row, kind) {
      if (propagationDepth > 0 || propagators.length === 0) return;
      propagationDepth += 1;
      try {
        for (const propagator of propagators) {
          propagator(row, kind);
        }
      } finally {
        propagationDepth = Math.max(0, propagationDepth - 1);
      }
    }
  };
};
//# sourceMappingURL=writePropagation.js.map