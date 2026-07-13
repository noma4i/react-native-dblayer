"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createConfiguredSlot = void 0;
/** Mutable configured-slot pair used by runtime seams (logger, transport, storage, query client, defaults, extract, tracking). */
const createConfiguredSlot = defaultValue => {
  let current = defaultValue;
  return {
    get: () => current,
    set: value => {
      current = value;
    }
  };
};
exports.createConfiguredSlot = createConfiguredSlot;
//# sourceMappingURL=configuredSlot.js.map