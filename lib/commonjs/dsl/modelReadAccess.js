"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createModelReadAccess = void 0;
var _compileDbWhere = require("../core/compileDbWhere.js");
var _incrementalReadEngine = require("../read/incrementalReadEngine.js");
var _useModelQuery = require("../read/useModelQuery.js");
var _projectionGate = require("../read/projectionGate.js");
var _arrayEquality = require("../utils/arrayEquality.js");
var _react = require("react");
var _readBuilder = require("./readBuilder.js");
const createModelReadAccess = options => {
  const {
    planes
  } = options.context;
  const rowDep = (id, fields) => ({
    kind: 'row',
    model: options.modelId,
    id,
    ...(fields ? {
      fields
    } : {})
  });
  const modelDep = {
    kind: 'model',
    model: options.modelId
  };
  const useScopeAccess = scopeKey => {
    (0, _react.useEffect)(() => {
      if (scopeKey != null) planes().scopeIndex.noteAccess(scopeKey);
    }, [scopeKey]);
  };
  /** Mechanical projection of the plane's persisted entry order - order keys are born on planning, never on read. */
  const scopeSortedRows = (scopeName, scopeValue) => {
    const value = planes().scopeIndex.read(options.keyForScope(scopeName, scopeValue));
    return value.entries.map(entry => planes().entityState.read(entry.id)).filter(row => row !== undefined);
  };
  const whereRead = where => {
    const defaultOrders = options.defaultOrder ? [options.defaultOrder] : [];
    return (0, _readBuilder.createReadBuilder)(where, {
      rows: function useRows(criteria, orders, limit, required, projection) {
        const effectiveOrders = orders.length > 0 ? orders : defaultOrders;
        (0, _projectionGate.validateProjectionOptions)(projection, `${options.modelId}.use.where`);
        const projectionRef = (0, _react.useRef)(projection);
        const gateRef = (0, _react.useRef)((0, _projectionGate.createProjectionGate)());
        projectionRef.current = projection;
        const signature = (0, _incrementalReadEngine.incrementalSignature)('where-builder', options.modelId, (0, _compileDbWhere.buildScopeKey)({
          criteria,
          orders: effectiveOrders,
          limit,
          required
        }));
        const spec = {
          where: criteria == null ? {
            or: []
          } : options.normalizeCriteria(criteria),
          orderBy: effectiveOrders,
          limit,
          required
        };
        return (0, _useModelQuery.useModelQuery)(options.modelId, signature, spec, rows => gateRef.current.projectRows(rows, projectionRef.current), _arrayEquality.arraysShallowEqual);
      },
      pluck: function usePluck(criteria, orders, limit, required, projection, field) {
        const effectiveOrders = orders.length > 0 ? orders : defaultOrders;
        const projectionRef = (0, _react.useRef)(projection);
        projectionRef.current = projection;
        const signature = (0, _incrementalReadEngine.incrementalSignature)('where-pluck', options.modelId, (0, _compileDbWhere.buildScopeKey)({
          criteria,
          orders: effectiveOrders,
          limit,
          required,
          field
        }));
        const spec = {
          where: criteria == null ? {
            or: []
          } : options.normalizeCriteria(criteria),
          orderBy: effectiveOrders,
          limit,
          required
        };
        return (0, _useModelQuery.useModelQuery)(options.modelId, signature, spec, rows => {
          const selector = projectionRef.current.select;
          const projected = selector ? rows.map(row => selector(row)) : rows;
          return projected.map(row => Reflect.get(row, field));
        }, _arrayEquality.arraysShallowEqual);
      },
      exists: function useExists(criteria, required) {
        const signature = (0, _incrementalReadEngine.incrementalSignature)('where-exists', options.modelId, (0, _compileDbWhere.buildScopeKey)({
          criteria,
          required
        }));
        // An inactive read declares a filter no row meets, so the hook shape never depends on it.
        const spec = {
          where: criteria == null ? {
            or: []
          } : options.normalizeCriteria(criteria),
          orderBy: [],
          limit: undefined,
          required
        };
        return (0, _useModelQuery.useModelQuery)(options.modelId, signature, spec, rows => rows.length > 0);
      }
    });
  };
  return {
    rowDep,
    modelDep,
    useScopeAccess,
    scopeSortedRows,
    whereRead
  };
};
exports.createModelReadAccess = createModelReadAccess;
//# sourceMappingURL=modelReadAccess.js.map