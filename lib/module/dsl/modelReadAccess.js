"use strict";

import { buildScopeKey } from "../core/compileDbWhere.js";
import { compareRowsBySpec } from "../core/ordering.js";
import { incrementalSignature } from "../read/readIdentity.js";
import { useModelQuery } from "../read/useModelQuery.js";
import { createProjectionGate, validateProjectionOptions } from "../read/projectionGate.js";
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
  /** Materializes membership rows; a client-sorted scope orders by its declared sort, server-order projects the persisted entry order. */
  const scopeSortedRows = (scopeName, scopeValue) => {
    const value = planes().scopeIndex.read(options.keyForScope(scopeName, scopeValue));
    const rows = value.entries.map(entry => planes().entityState.read(entry.id)).filter(row => row !== undefined);
    const sort = options.scopes?.[scopeName]?.sort;
    if (!sort || sort === 'server-order') return rows;
    return rows.sort(compareRowsBySpec(sort));
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
        const spec = {
          where: criteria == null ? {
            or: []
          } : options.normalizeCriteria(criteria),
          orderBy: effectiveOrders,
          limit,
          required
        };
        return useModelQuery(options.modelId, signature, spec, rows => gateRef.current.projectRows(rows, projectionRef.current), arraysShallowEqual);
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
        const spec = {
          where: criteria == null ? {
            or: []
          } : options.normalizeCriteria(criteria),
          orderBy: effectiveOrders,
          limit,
          required
        };
        return useModelQuery(options.modelId, signature, spec, rows => {
          const selector = projectionRef.current.select;
          const projected = selector ? rows.map(row => selector(row)) : rows;
          return projected.map(row => Reflect.get(row, field));
        }, arraysShallowEqual);
      },
      exists: function useExists(criteria, required) {
        const signature = incrementalSignature('where-exists', options.modelId, buildScopeKey({
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
        return useModelQuery(options.modelId, signature, spec, rows => rows.length > 0);
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