"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createModelCriteria = void 0;
var _compileDbWhere = require("../core/compileDbWhere.js");
var _fieldCodec = require("../schema/fieldCodec.js");
const createModelCriteria = fields => {
  const cache = new WeakMap();
  const normalize = where => {
    if (typeof where !== 'object' || where === null || Array.isArray(where)) return where;
    const record = where;
    if ('and' in record) return {
      and: record.and.map(normalize)
    };
    if ('or' in record) return {
      or: record.or.map(normalize)
    };
    if ('not' in record) return {
      not: normalize(record.not)
    };
    const out = {};
    for (const [key, value] of Object.entries(record)) {
      const fieldSpec = fields[key];
      const operand = raw => {
        if (raw === undefined || raw === null) return raw;
        if (key === 'id') return _fieldCodec.scalarFieldCodecs.id.read(raw);
        const normalized = fieldSpec ? fieldSpec.readValue(raw) : undefined;
        return normalized === undefined || normalized === null ? raw : normalized;
      };
      out[key] = (0, _compileDbWhere.isWhereOperatorValue)(value) ? Object.fromEntries(Object.entries(value).map(([operator, raw]) => [operator, Array.isArray(raw) ? raw.map(operand) : operand(raw)])) : operand(value);
    }
    return out;
  };
  const normalizeCached = where => {
    if (typeof where !== 'object' || where === null) return where;
    let normalized = cache.get(where);
    if (!normalized) {
      normalized = normalize(where);
      cache.set(where, normalized);
    }
    return normalized;
  };
  return {
    // One normalization for both readers of a filter: the row predicate and the query compiler.
    normalize: normalizeCached,
    matches: (row, where) => (0, _compileDbWhere.matchesDbWhere)(row, normalizeCached(where))
  };
};
exports.createModelCriteria = createModelCriteria;
//# sourceMappingURL=modelCriteria.js.map