"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createCommitBus = void 0;
/** Emits exactly one semantic notification after an applied plan commits. */
const createCommitBus = () => {
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
exports.createCommitBus = createCommitBus;
//# sourceMappingURL=commitBus.js.map