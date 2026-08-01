"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createModelReactiveReads = void 0;
var _readIdentity = require("../read/readIdentity.js");
var _useModelQuery = require("../read/useModelQuery.js");
var _projectionGate = require("../read/projectionGate.js");
var _requireFields = require("../read/requireFields.js");
var _useLiveRead = require("../read/useLiveRead.js");
var _react = require("react");
var _ordering = require("../core/ordering.js");
var _arrayEquality = require("../utils/arrayEquality.js");
var _rowOperationState = require("./rowOperationState.js");
const EMPTY_ROWS = [];
const createModelReactiveReads = options => {
  const {
    planes,
    resolvedRelations
  } = options.context;
  return {
    pending: function usePending(id) {
      return (0, _rowOperationState.useRowOperationState)(options.modelId, id).pending;
    },
    failed: function useFailed(id) {
      return (0, _rowOperationState.useRowOperationState)(options.modelId, id).failed;
    },
    unsyncedChanges: function useUnsyncedChanges(id) {
      return (0, _rowOperationState.useRowOperationState)(options.modelId, id).unsyncedChanges;
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
      const signature = (0, _readIdentity.incrementalSignature)('first', options.modelId, where, order, readOptions.limit, readOptions.require);
      const spec = {
        where: where == null ? undefined : options.normalizeCriteria(where),
        orderBy: order ? [{
          field: String(order.field),
          direction: order.direction
        }] : [],
        limit: readOptions.limit,
        required: readOptions.require ?? []
      };
      return (0, _useModelQuery.useModelQuery)(options.modelId, signature, spec, rows => rows[0] ? gateRef.current.project(rows[0], optionsRef.current) : undefined);
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
      const signature = (0, _readIdentity.incrementalSignature)('count', options.modelId, where);
      const spec = {
        where: where == null ? undefined : options.normalizeCriteria(where),
        orderBy: [],
        limit: undefined,
        required: []
      };
      return (0, _useModelQuery.useModelQuery)(options.modelId, signature, spec, rows => rows.length);
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
      let isEqual = Object.is;
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
          return (0, _ordering.pickLowestRow)(relation.model.where({
            [relation.foreignKey]: id
          }), comparator);
        };
        deps = id == null ? [] : [options.rowDep(id), {
          kind: 'model',
          model: relation.model.modelId
        }];
      } else {
        const idsOf = () => {
          const source = id == null ? undefined : planes().entityState.read(id);
          if (!source) return [];
          const selected = relation.ids(source);
          return (Array.isArray(selected) ? selected : [selected]).flatMap(targetId => targetId == null ? [] : [String(targetId)]);
        };
        compute = () => idsOf().flatMap(targetId => {
          const row = relation.model.find(targetId);
          return row ? [row] : [];
        });
        deps = id == null ? [] : [options.rowDep(id), ...idsOf().map(targetId => ({
          kind: 'row',
          model: relation.model.modelId,
          id: targetId
        }))];
        isEqual = (left, right) => Array.isArray(left) && Array.isArray(right) && (0, _arrayEquality.arraysShallowEqual)(left, right);
      }
      return (0, _useLiveRead.useLiveRead)(compute, deps, isEqual);
    }
  };
};
exports.createModelReactiveReads = createModelReactiveReads;
//# sourceMappingURL=modelReactiveReads.js.map