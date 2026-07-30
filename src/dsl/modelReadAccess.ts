import { buildScopeKey } from '../core/compileDbWhere';
import { createModelReadEngine, incrementalSignature, useIncrementalRead } from '../read/incrementalReadEngine';
import { createProjectionGate, validateProjectionOptions } from '../read/projectionGate';
import { hasRequiredFields } from '../read/requireFields';
import { arraysShallowEqual } from '../utils/arrayEquality';
import type { DbWhere, Dependency, ModelContext, ModelReadAccess, ModelReadBuilder, ProjectionOptions, ReadOrder, ScopeSpec } from '../types';
import { useEffect, useRef } from 'react';
import { createReadBuilder } from './readBuilder';

export const createModelReadAccess = <TStored extends { id: string } & Record<string, unknown>>(options: {
  modelId: string;
  context: ModelContext<TStored>;
  scopes: Record<string, ScopeSpec<TStored>> | undefined;
  defaultOrder?: ReadOrder<TStored>;
  keyForScope(scopeName: string, scopeValue: unknown): string;
  matchesCriteria(row: TStored, where: DbWhere<TStored>): boolean;
}): ModelReadAccess<TStored> => {
  const { planes } = options.context;
  const rowDep = (id: string, fields?: ReadonlyArray<string>): Dependency => ({ kind: 'row', model: options.modelId, id, ...(fields ? { fields } : {}) });
  const modelDep: Dependency = { kind: 'model', model: options.modelId };
  const useScopeAccess = (scopeKey: string | null): void => {
    useEffect(() => {
      if (scopeKey != null) planes().scopeIndex.noteAccess(scopeKey);
    }, [scopeKey]);
  };
  /** Mechanical projection of the plane's persisted entry order - order keys are born on planning, never on read. */
  const scopeSortedRows = (scopeName: string, scopeValue: unknown): TStored[] => {
    const value = planes().scopeIndex.read(options.keyForScope(scopeName, scopeValue));
    return value.entries.map(entry => planes().entityState.read(entry.id)).filter((row): row is TStored => row !== undefined);
  };
  const whereRead = (where: DbWhere<TStored> | null): ModelReadBuilder<TStored> => {
    const defaultOrders: ReadonlyArray<ReadOrder<TStored>> = options.defaultOrder ? [options.defaultOrder] : [];
    return createReadBuilder(where, {
      rows: function useRows<TOutput extends Record<string, unknown>>(
        criteria: DbWhere<TStored> | null,
        orders: readonly ReadOrder<TStored>[],
        limit: number | undefined,
        required: readonly string[],
        projection: ProjectionOptions<TStored, TOutput>
      ): TOutput[] {
        const effectiveOrders = orders.length > 0 ? orders : defaultOrders;
        validateProjectionOptions(projection, `${options.modelId}.use.where`);
        const projectionRef = useRef(projection);
        const gateRef = useRef(createProjectionGate<TStored, TOutput>());
        projectionRef.current = projection;
        const signature = incrementalSignature('where-builder', options.modelId, buildScopeKey({ criteria, orders: effectiveOrders, limit, required }));
        return useIncrementalRead({
          signature,
          deps: criteria == null ? [] : [modelDep],
          create: () =>
            createModelReadEngine({
              signature,
              model: options.modelId,
              where: row => criteria != null && options.matchesCriteria(row, criteria) && hasRequiredFields(row, required),
              options: { orderBy: effectiveOrders as ReadonlyArray<{ field: string; direction: 'asc' | 'desc' }>, limit },
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
        const signature = incrementalSignature('where-pluck', options.modelId, buildScopeKey({ criteria, orders: effectiveOrders, limit, required, field }));
        return useIncrementalRead({
          signature,
          deps: criteria == null ? [] : [modelDep],
          create: () =>
            createModelReadEngine<TStored, unknown[]>({
              signature,
              model: options.modelId,
              where: row => criteria != null && options.matchesCriteria(row, criteria) && hasRequiredFields(row, required),
              options: { orderBy: effectiveOrders as ReadonlyArray<{ field: string; direction: 'asc' | 'desc' }>, limit },
              initial: () => planes().entityState.values(),
              read: id => planes().entityState.read(id),
              select: rows => {
                const selector = projectionRef.current.select;
                const projected: readonly object[] = selector ? rows.map(row => selector(row)) : rows;
                return projected.map(row => Reflect.get(row, field));
              },
              isEqual: arraysShallowEqual
            })
        });
      },
      exists: function useExists(criteria, required) {
        const signature = incrementalSignature('where-exists', options.modelId, buildScopeKey({ criteria, required }));
        return useIncrementalRead({
          signature,
          deps: criteria == null ? [] : [modelDep],
          create: () =>
            createModelReadEngine<TStored, boolean>({
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
  return { rowDep, modelDep, useScopeAccess, scopeSortedRows, whereRead };
};
