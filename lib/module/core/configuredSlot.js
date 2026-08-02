"use strict";

/** Mutable configured-slot pair used by runtime seams (logger, transport, storage, query client, defaults, writes, tracking). */
export const createConfiguredSlot = defaultValue => {
  let current = defaultValue;
  return {
    get: () => current,
    set: value => {
      current = value;
    }
  };
};
//# sourceMappingURL=configuredSlot.js.map