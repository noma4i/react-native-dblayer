"use strict";

/** Emits exactly one semantic notification after an applied plan commits. */
export const createCommitBus = () => {
  const listeners = new Set();
  return {
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish: changes => {
      if (!changes.length) return;
      for (const listener of listeners) listener(changes);
    }
  };
};
//# sourceMappingURL=commitBus.js.map