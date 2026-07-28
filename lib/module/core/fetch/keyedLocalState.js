"use strict";

/**
 * The ONE home for per-key reader-local state that react-query's vocabulary cannot express
 * (offline pause, next-page distinction). Both `defineQuery` and `defineFetch` keep their
 * per-key flags, change versions, and listener fan-out here instead of hand-rolling the
 * same three maps each.
 */

export const createKeyedLocalState = initial => {
  const states = new Map();
  const versions = new Map();
  const listeners = new Map();
  return {
    get: key => states.get(key) ?? initial,
    set: (key, next) => {
      const previous = states.get(key) ?? initial;
      const merged = {
        ...previous,
        ...next
      };
      if (Object.keys(merged).every(field => merged[field] === previous[field])) return;
      states.set(key, merged);
      versions.set(key, (versions.get(key) ?? 0) + 1);
      for (const listener of listeners.get(key) ?? []) listener();
    },
    subscribe: (key, listener) => {
      const keyListeners = listeners.get(key) ?? new Set();
      listeners.set(key, keyListeners);
      keyListeners.add(listener);
      return () => {
        keyListeners.delete(listener);
        if (keyListeners.size === 0) listeners.delete(key);
      };
    },
    version: key => versions.get(key) ?? 0,
    clear: () => {
      states.clear();
      versions.clear();
      listeners.clear();
    }
  };
};
//# sourceMappingURL=keyedLocalState.js.map