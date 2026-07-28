"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createModelReactiveReads = void 0;
var _incrementalReadEngine = require("../read/incrementalReadEngine.js");
var _projectionGate = require("../read/projectionGate.js");
var _requireFields = require("../read/requireFields.js");
var _useLiveRead = require("../read/useLiveRead.js");
var _react = require("react");
var _configure = require("./configure.js");
const EMPTY_ROWS = [];
const createModelReactiveReads = options => {
  const {
    planes,
    resolvedRelations
  } = options.context;
  return {
    pending: function usePending(id) {
      const key = id == null ? null : String(id);
      const readPending = (0, _react.useCallback)(() => key != null && (0, _configure.getOperationState)().pendingForRow(options.modelId, key).length > 0, [key]);
      const subscribePending = (0, _react.useCallback)(listener => {
        if (key == null) return () => {};
        const subscription = (0, _configure.getCommitBus)().subscribe(listener, [{
          kind: 'pending',
          model: options.modelId,
          id: key
        }]);
        return () => subscription.unsubscribe();
      }, [key]);
      return (0, _react.useSyncExternalStore)(subscribePending, readPending, readPending);
    },
    failed: function useFailed(id) {
      const key = id == null ? null : String(id);
      const readFailed = (0, _react.useCallback)(() => key != null && (0, _configure.getOperationState)().failedFor(options.modelId, key) !== undefined, [key]);
      const subscribeFailed = (0, _react.useCallback)(listener => {
        if (key == null) return () => {};
        const subscription = (0, _configure.getCommitBus)().subscribe(listener, [{
          kind: 'pending',
          model: options.modelId,
          id: key
        }]);
        return () => subscription.unsubscribe();
      }, [key]);
      return (0, _react.useSyncExternalStore)(subscribeFailed, readFailed, readFailed);
    },
    unsyncedChanges: function useUnsyncedChanges(id) {
      const key = id == null ? null : String(id);
      const cacheRef = (0, _react.useRef)(undefined);
      const readChanges = (0, _react.useCallback)(() => {
        if (key == null) return undefined;
        let merged;
        for (const operation of (0, _configure.getOperationState)().pendingForRow(options.modelId, key)) {
          if (operation.intent !== 'patch') continue;
          if (!operation.patchedValues) continue;
          merged = {
            ...(merged ?? {}),
            ...operation.patchedValues
          };
        }
        const next = merged;
        const previous = cacheRef.current;
        if (previous && next && (0, _useLiveRead.rowsShallowEqual)(previous, next)) return previous;
        cacheRef.current = next;
        return next;
      }, [key]);
      const subscribeChanges = (0, _react.useCallback)(listener => {
        if (key == null) return () => {};
        const subscription = (0, _configure.getCommitBus)().subscribe(listener, [{
          kind: 'pending',
          model: options.modelId,
          id: key
        }]);
        return () => subscription.unsubscribe();
      }, [key]);
      return (0, _react.useSyncExternalStore)(subscribeChanges, readChanges, readChanges);
    },
    find: (id, readOptions = {}) => {
      const required = readOptions?.require ?? [];
      const key = id == null ? undefined : String(id);
      return (0, _projectionGate.useProjectedLiveRow)(() => {
        const row = key == null ? undefined : planes().entityState.read(key);
        return (0, _requireFields.hasRequiredFields)(row, required) ? row : undefined;
      }, key == null ? [] : [options.rowDep(key, required.length > 0 ? required : undefined)], readOptions, `${options.modelId}.use.find`);
    },
    field: function useField(id, field) {
      const key = id == null ? undefined : String(id);
      return (0, _useLiveRead.useLiveRead)(() => key == null ? undefined : planes().entityState.read(key)?.[field], key == null ? [] : [options.rowDep(key, [String(field)])]);
    },
    first: (where, readOptions = {}) => {
      (0, _projectionGate.validateProjectionOptions)(readOptions, `${options.modelId}.use.first`);
      const optionsRef = (0, _react.useRef)(readOptions);
      const gateRef = (0, _react.useRef)((0, _projectionGate.createProjectionGate)());
      optionsRef.current = readOptions;
      const order = readOptions.orderBy ?? options.defaultOrder;
      const signature = (0, _incrementalReadEngine.incrementalSignature)('first', options.modelId, where, order, readOptions.limit, readOptions.require);
      return (0, _incrementalReadEngine.useIncrementalRead)({
        signature,
        deps: [options.modelDep],
        create: () => (0, _incrementalReadEngine.createModelReadEngine)({
          signature,
          model: options.modelId,
          where: row => (where == null || options.matchesCriteria(row, where)) && (0, _requireFields.hasRequiredFields)(row, optionsRef.current.require ?? []),
          options: order ? {
            orderBy: [{
              field: String(order.field),
              direction: order.direction
            }],
            limit: readOptions.limit
          } : {
            limit: readOptions.limit
          },
          initial: () => planes().entityState.values(),
          read: id => planes().entityState.read(id),
          select: rows => rows[0] ? gateRef.current.project(rows[0], optionsRef.current) : undefined,
          isEqual: Object.is
        })
      });
    },
    where: options.whereRead,
    byIds: (ids, readOptions = {}) => {
      const resolvedIds = (ids ?? []).map(id => String(id));
      (0, _projectionGate.validateProjectionOptions)(readOptions, `${options.modelId}.use.byIds`);
      const optionsRef = (0, _react.useRef)(readOptions);
      const gateRef = (0, _react.useRef)((0, _projectionGate.createProjectionGate)());
      const resultRef = (0, _react.useRef)(null);
      optionsRef.current = readOptions;
      return (0, _useLiveRead.useLiveRead)(() => {
        const sources = [];
        for (const id of resolvedIds) {
          const source = planes().entityState.read(id);
          if (source !== undefined) sources.push(source);
        }
        const rows = gateRef.current.projectRows(sources, optionsRef.current);
        if (resultRef.current?.rows === rows) return resultRef.current;
        resultRef.current = {
          rows,
          byId: new Map(sources.map(source => [source.id, gateRef.current.project(source, optionsRef.current)]))
        };
        return resultRef.current;
      }, resolvedIds.map(id => options.rowDep(id)), Object.is);
    },
    count: function useCount(where) {
      return (0, _incrementalReadEngine.useIncrementalRead)({
        signature: (0, _incrementalReadEngine.incrementalSignature)('count', options.modelId, where),
        deps: [options.modelDep],
        create: () => (0, _incrementalReadEngine.createModelReadEngine)({
          signature: (0, _incrementalReadEngine.incrementalSignature)('count', options.modelId, where),
          model: options.modelId,
          where: row => where == null || options.matchesCriteria(row, where),
          initial: () => planes().entityState.values(),
          read: id => planes().entityState.read(id),
          select: (_rows, count) => count,
          countOnly: true
        })
      });
    },
    related: (id, relationName, readOptions = {}) => {
      const relation = resolvedRelations()[relationName];
      if (!relation) throw new Error(`${options.modelName} has no relation ${relationName}`);
      if (relation.kind === 'hasMany') {
        return (0, _projectionGate.useProjectedLiveRows)(() => id == null ? EMPTY_ROWS : relation.model.where({
          [relation.foreignKey]: id
        }), id == null ? [] : [options.rowDep(id), {
          kind: 'model',
          model: relation.model.modelId
        }], readOptions, `${options.modelId}.use.related`);
      }
      let compute;
      let deps;
      const isEqual = Object.is;
      if (relation.kind === 'belongsTo') {
        const parentIdOf = () => {
          const child = id == null ? undefined : planes().entityState.read(id);
          const value = child?.[relation.foreignKey];
          return typeof value === 'string' && value.length > 0 ? value : null;
        };
        compute = () => {
          const parentId = parentIdOf();
          return parentId ? relation.model.find(parentId) : undefined;
        };
        const parentId = parentIdOf();
        deps = id == null ? [] : [options.rowDep(id, [relation.foreignKey]), ...(parentId ? [{
          kind: 'row',
          model: relation.model.modelId,
          id: parentId
        }] : [])];
      } else if (relation.kind === 'hasOne') {
        const comparator = relation.comparator;
        compute = () => {
          if (id == null) return undefined;
          const rows = relation.model.where({
            [relation.foreignKey]: id
          });
          if (rows.length === 0) return undefined;
          return comparator ? rows.reduce((best, row) => comparator(row, best) < 0 ? row : best) : rows[0];
        };
        deps = id == null ? [] : [options.rowDep(id), {
          kind: 'model',
          model: relation.model.modelId
        }];
      } else {
        compute = () => undefined;
        deps = [];
      }
      return (0, _useLiveRead.useLiveRead)(compute, deps, isEqual);
    }
  };
};
exports.createModelReactiveReads = createModelReactiveReads;
//# sourceMappingURL=modelReactiveReads.js.map