"use strict";

import { buildScopeKey } from "../core/compileDbWhere.js";
import { compareCodepoints } from "../core/serialize.js";
import { createModelReadEngine, incrementalSignature, useIncrementalRead } from "../read/incrementalReadEngine.js";
import { createProjectionGate, validateProjectionOptions } from "../read/projectionGate.js";
import { hasRequiredFields } from "../read/requireFields.js";
import { arraysShallowEqual } from "../read/useLiveRead.js";
import { useEffect, useRef } from 'react';
import { createReadBuilder } from "./readBuilder.js";

/** Canonical scope-sort comparator: declared comparator or field order (NULLS LAST), always with the codepoint id tie-break shared by every read surface. */
export const compareRowsBySpec = sort => {
  if ('comparator' in sort) return (left, right) => sort.comparator(left, right) || compareCodepoints(left.id, right.id);
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
    return compareCodepoints(left.id, right.id);
  };
};
export const createModelReadAccess = options => {
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
    useEffect(() => {
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
    return createReadBuilder(where, {
      rows: function useRows(criteria, orders, limit, required, projection) {
        const effectiveOrders = orders.length > 0 ? orders : defaultOrders;
        validateProjectionOptions(projection, `${options.modelId}.use.where`);
        const projectionRef = useRef(projection);
        const gateRef = useRef(createProjectionGate());
        projectionRef.current = projection;
        const signature = incrementalSignature('where-builder', options.modelId, buildScopeKey({
          criteria,
          orders: effectiveOrders,
          limit,
          required
        }));
        return useIncrementalRead({
          signature,
          deps: criteria == null ? [] : [modelDep],
          create: () => createModelReadEngine({
            signature,
            model: options.modelId,
            where: row => criteria != null && options.matchesCriteria(row, criteria) && hasRequiredFields(row, required),
            options: {
              orderBy: effectiveOrders,
              limit
            },
            initial: () => planes().entityState.values(),
            read: id => planes().entityState.read(id),
            select: rows => gateRef.current.projectRows(rows, projectionRef.current),
            isEqual: arraysShallowEqual
          })
        });
      },
      pluck: function usePluck(criteria, orders, limit, required, projection, field) {
        const effectiveOrders = orders.length > 0 ? orders : defaultOrders;
        const projectionRef = useRef(projection);
        projectionRef.current = projection;
        const signature = incrementalSignature('where-pluck', options.modelId, buildScopeKey({
          criteria,
          orders: effectiveOrders,
          limit,
          required,
          field
        }));
        return useIncrementalRead({
          signature,
          deps: criteria == null ? [] : [modelDep],
          create: () => createModelReadEngine({
            signature,
            model: options.modelId,
            where: row => criteria != null && options.matchesCriteria(row, criteria) && hasRequiredFields(row, required),
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
            isEqual: arraysShallowEqual
          })
        });
      },
      exists: function useExists(criteria, required) {
        const signature = incrementalSignature('where-exists', options.modelId, buildScopeKey({
          criteria,
          required
        }));
        return useIncrementalRead({
          signature,
          deps: criteria == null ? [] : [modelDep],
          create: () => createModelReadEngine({
            signature,
            model: options.modelId,
            where: row => criteria != null && options.matchesCriteria(row, criteria) && hasRequiredFields(row, required),
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
//# sourceMappingURL=modelReadAccess.js.map