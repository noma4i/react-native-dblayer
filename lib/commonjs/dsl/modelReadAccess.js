"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createModelReadAccess = exports.compareRowsBySpec = void 0;
var _compileDbWhere = require("../core/compileDbWhere.js");
var _serialize = require("../core/serialize.js");
var _incrementalReadEngine = require("../read/incrementalReadEngine.js");
var _projectionGate = require("../read/projectionGate.js");
var _requireFields = require("../read/requireFields.js");
var _useLiveRead = require("../read/useLiveRead.js");
var _react = require("react");
var _readBuilder = require("./readBuilder.js");
/** Canonical scope-sort comparator: declared comparator or field order (NULLS LAST), always with the codepoint id tie-break shared by every read surface. */
const compareRowsBySpec = sort => {
  if ('comparator' in sort) return (left, right) => sort.comparator(left, right) || (0, _serialize.compareCodepoints)(left.id, right.id);
  const field = String(sort.field);
  const direction = sort.dir;
  return (left, right) => {
    const a = left[field];
    const b = right[field];
    const aMissing = a == null;
    const bMissing = b == null;
    if (!aMissing || !bMissing) {
      if (aMissing) return 1;
      if (bMissing) return -1;
      if (!Object.is(a, b)) {
        const result = a < b ? -1 : 1;
        return direction === 'asc' ? result : -result;
      }
    }
    return (0, _serialize.compareCodepoints)(left.id, right.id);
  };
};
exports.compareRowsBySpec = compareRowsBySpec;
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
  const scopeDep = scopeKey => ({
    kind: 'scope',
    model: options.modelId,
    scopeKey
  });
  const memberDeps = scopeKey => [scopeDep(scopeKey)];
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
        return (0, _incrementalReadEngine.useIncrementalRead)({
          signature,
          deps: criteria == null ? [] : [modelDep],
          create: () => (0, _incrementalReadEngine.createModelReadEngine)({
            signature,
            model: options.modelId,
            where: row => criteria != null && options.matchesCriteria(row, criteria) && (0, _requireFields.hasRequiredFields)(row, required),
            options: {
              orderBy: effectiveOrders,
              limit
            },
            initial: () => planes().entityState.values(),
            read: id => planes().entityState.read(id),
            select: rows => gateRef.current.projectRows(rows, projectionRef.current),
            isEqual: _useLiveRead.arraysShallowEqual
          })
        });
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
        return (0, _incrementalReadEngine.useIncrementalRead)({
          signature,
          deps: criteria == null ? [] : [modelDep],
          create: () => (0, _incrementalReadEngine.createModelReadEngine)({
            signature,
            model: options.modelId,
            where: row => criteria != null && options.matchesCriteria(row, criteria) && (0, _requireFields.hasRequiredFields)(row, required),
            options: {
              orderBy: effectiveOrders,
              limit
            },
            initial: () => planes().entityState.values(),
            read: id => planes().entityState.read(id),
            select: rows => {
              const selector = projectionRef.current.select;
              const projected = selector ? rows.map(row => selector(row)) : rows;
              return projected.map(row => Reflect.get(row, field));
            },
            isEqual: _useLiveRead.arraysShallowEqual
          })
        });
      },
      exists: function useExists(criteria, required) {
        const signature = (0, _incrementalReadEngine.incrementalSignature)('where-exists', options.modelId, (0, _compileDbWhere.buildScopeKey)({
          criteria,
          required
        }));
        return (0, _incrementalReadEngine.useIncrementalRead)({
          signature,
          deps: criteria == null ? [] : [modelDep],
          create: () => (0, _incrementalReadEngine.createModelReadEngine)({
            signature,
            model: options.modelId,
            where: row => criteria != null && options.matchesCriteria(row, criteria) && (0, _requireFields.hasRequiredFields)(row, required),
            initial: () => planes().entityState.values(),
            read: id => planes().entityState.read(id),
            select: (_rows, count) => count > 0,
            countOnly: true
          })
        });
      }
    });
  };
  return {
    rowDep,
    modelDep,
    scopeDep,
    memberDeps,
    useScopeAccess,
    scopeSortedRows,
    whereRead
  };
};
exports.createModelReadAccess = createModelReadAccess;
//# sourceMappingURL=modelReadAccess.js.map