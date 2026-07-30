"use strict";

import { createModelReadEngine, incrementalSignature, useIncrementalRead } from "../read/incrementalReadEngine.js";
import { createProjectionGate, useProjectedLiveRow, useProjectedLiveRows, validateProjectionOptions } from "../read/projectionGate.js";
import { hasRequiredFields } from "../read/requireFields.js";
import { useLiveRead } from "../read/useLiveRead.js";
import { useRef } from 'react';
import { withIdTieBreak } from "../core/ordering.js";
import { arraysShallowEqual } from "../utils/arrayEquality.js";
import { useRowOperationState } from "./rowOperationState.js";
const EMPTY_ROWS = [];
export const createModelReactiveReads = options => {
  const {
    planes,
    resolvedRelations
  } = options.context;
  return {
    pending: function usePending(id) {
      return useRowOperationState(options.modelId, id).pending;
    },
    failed: function useFailed(id) {
      return useRowOperationState(options.modelId, id).failed;
    },
    unsyncedChanges: function useUnsyncedChanges(id) {
      return useRowOperationState(options.modelId, id).unsyncedChanges;
    },
    find: (id, readOptions = {}) => {
      const required = readOptions?.require ?? [];
      const key = id == null ? undefined : String(id);
      return useProjectedLiveRow(() => {
        const row = key == null ? undefined : planes().entityState.read(key);
        return hasRequiredFields(row, required) ? row : undefined;
      }, key == null ? [] : [options.rowDep(key, required.length > 0 ? required : undefined)], readOptions, `${options.modelId}.use.find`);
    },
    field: function useField(id, field) {
      const key = id == null ? undefined : String(id);
      return useLiveRead(() => key == null ? undefined : planes().entityState.read(key)?.[field], key == null ? [] : [options.rowDep(key, [String(field)])]);
    },
    first: (where, readOptions = {}) => {
      validateProjectionOptions(readOptions, `${options.modelId}.use.first`);
      const optionsRef = useRef(readOptions);
      const gateRef = useRef(createProjectionGate());
      optionsRef.current = readOptions;
      const order = readOptions.orderBy ?? options.defaultOrder;
      const signature = incrementalSignature('first', options.modelId, where, order, readOptions.limit, readOptions.require);
      return useIncrementalRead({
        signature,
        deps: [options.modelDep],
        create: () => createModelReadEngine({
          signature,
          model: options.modelId,
          where: row => (where == null || options.matchesCriteria(row, where)) && hasRequiredFields(row, optionsRef.current.require ?? []),
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
      validateProjectionOptions(readOptions, `${options.modelId}.use.byIds`);
      const optionsRef = useRef(readOptions);
      const gateRef = useRef(createProjectionGate());
      const resultRef = useRef(null);
      optionsRef.current = readOptions;
      return useLiveRead(() => {
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
      return useIncrementalRead({
        signature: incrementalSignature('count', options.modelId, where),
        deps: [options.modelDep],
        create: () => createModelReadEngine({
          signature: incrementalSignature('count', options.modelId, where),
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
        return useProjectedLiveRows(() => id == null ? EMPTY_ROWS : relation.model.where({
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
        const compare = comparator ? withIdTieBreak(comparator) : undefined;
        compute = () => {
          if (id == null) return undefined;
          const rows = relation.model.where({
            [relation.foreignKey]: id
          });
          if (rows.length === 0) return undefined;
          return compare ? rows.reduce((best, row) => compare(row, best) < 0 ? row : best) : rows[0];
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
        isEqual = (left, right) => Array.isArray(left) && Array.isArray(right) && arraysShallowEqual(left, right);
      }
      return useLiveRead(compute, deps, isEqual);
    }
  };
};
//# sourceMappingURL=modelReactiveReads.js.map