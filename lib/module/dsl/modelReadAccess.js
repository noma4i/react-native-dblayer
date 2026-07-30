"use strict";

import { buildScopeKey } from "../core/compileDbWhere.js";
import { createModelReadEngine, incrementalSignature, useIncrementalRead } from "../read/incrementalReadEngine.js";
import { createProjectionGate, validateProjectionOptions } from "../read/projectionGate.js";
import { hasRequiredFields } from "../read/requireFields.js";
import { arraysShallowEqual } from "../utils/arrayEquality.js";
import { useEffect, useRef } from 'react';
import { createReadBuilder } from "./readBuilder.js";
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
    useScopeAccess,
    scopeSortedRows,
    whereRead
  };
};
//# sourceMappingURL=modelReadAccess.js.map