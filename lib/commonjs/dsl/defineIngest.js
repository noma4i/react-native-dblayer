"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineIngest = void 0;
/** Compile a subscription declaration through the same public model write channel as mutations. */
const defineIngest = (model, handlers) => ({
  apply: (event, payload) => {
    const declaration = handlers[event]?.(payload) ?? null;
    if (!declaration) return null;
    const rows = declaration.upsert == null ? [] : Array.isArray(declaration.upsert) ? declaration.upsert : [declaration.upsert];
    for (const row of rows) model.insertStored(row);
    const ids = declaration.destroy == null ? [] : Array.isArray(declaration.destroy) ? declaration.destroy : [declaration.destroy];
    if (ids.length > 0) model.destroyMany(ids);
    if (declaration.invalidate) model.invalidate();
    return declaration;
  }
});
exports.defineIngest = defineIngest;
//# sourceMappingURL=defineIngest.js.map