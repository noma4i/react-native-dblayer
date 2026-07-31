import type { DbReadOptions, DbWhere, Dependency, ModelContext, ModelCore, ProjectionOptions, StoredRowShape, ModelReadBuilder } from '../types';
import { createModelReadEngine, incrementalSignature, useIncrementalRead } from '../read/incrementalReadEngine';
import { createProjectionGate, useProjectedLiveRow, useProjectedLiveRows, validateProjectionOptions } from '../read/projectionGate';
import { hasRequiredFields } from '../read/requireFields';
import { useLiveRead } from '../read/useLiveRead';
import { useRef } from 'react';
import { pickLowestRow } from '../core/ordering';
import { arraysShallowEqual } from '../utils/arrayEquality';
import { useRowOperationState } from './rowOperationState';

const EMPTY_ROWS: never[] = [];

export const createModelReactiveReads = <TStored extends { id: string } & Record<string, unknown>, TInput>(options: {
  modelId: string;
  modelName: string;
  context: ModelContext<TStored>;
  defaultOrder?: DbReadOptions<TStored>['orderBy'];
  matchesCriteria(row: TStored, where: DbWhere<TStored>): boolean;
  rowDep(id: string, fields?: ReadonlyArray<string>): Dependency;
  modelDep: Dependency;
  whereRead(where: DbWhere<TStored> | null): ModelReadBuilder<TStored>;
}): ModelCore<TStored, TInput>['use'] => {
  const { planes, resolvedRelations } = options.context;
  return {
    pending: function usePending(id) {
      return useRowOperationState<TStored>(options.modelId, id).pending;
    },
    failed: function useFailed(id) {
      return useRowOperationState<TStored>(options.modelId, id).failed;
    },
    unsyncedChanges: function useUnsyncedChanges(id) {
      return useRowOperationState<TStored>(options.modelId, id).unsyncedChanges;
    },
    find: ((id: string | null | undefined, readOptions: { require?: readonly string[] } & ProjectionOptions<TStored, Record<string, unknown>> = {}) => {
      const required = readOptions?.require ?? [];
      const key = id == null ? undefined : String(id);
      return useProjectedLiveRow(
        () => {
          const row = key == null ? undefined : planes().entityState.read(key);
          return hasRequiredFields(row, required) ? row : undefined;
        },
        key == null ? [] : [options.rowDep(key, required.length > 0 ? required : undefined)],
        readOptions,
        `${options.modelId}.use.find`
      );
    }) as ModelCore<TStored, TInput>['use']['find'],
    field: function useField(id, field) {
      const key = id == null ? undefined : String(id);
      return useLiveRead(() => (key == null ? undefined : planes().entityState.read(key)?.[field]), key == null ? [] : [options.rowDep(key, [String(field)])]);
    },
    first: ((
      where: DbWhere<TStored> | null | undefined,
      readOptions: DbReadOptions<TStored> & { require?: readonly string[] } & ProjectionOptions<TStored, Record<string, unknown>> = {}
    ) => {
      validateProjectionOptions(readOptions, `${options.modelId}.use.first`);
      const optionsRef = useRef(readOptions);
      const gateRef = useRef(createProjectionGate<TStored, Record<string, unknown>>());
      optionsRef.current = readOptions;
      const order = readOptions.orderBy ?? options.defaultOrder;
      const signature = incrementalSignature('first', options.modelId, where, order, readOptions.limit, readOptions.require);
      return useIncrementalRead({
        signature,
        deps: [options.modelDep],
        create: () =>
          createModelReadEngine({
            signature,
            model: options.modelId,
            where: row => (where == null || options.matchesCriteria(row, where)) && hasRequiredFields(row, optionsRef.current.require ?? []),
            options: order ? { orderBy: [{ field: String(order.field), direction: order.direction }], limit: readOptions.limit } : { limit: readOptions.limit },
            initial: () => planes().entityState.values(),
            read: id => planes().entityState.read(id),
            select: rows => (rows[0] ? gateRef.current.project(rows[0], optionsRef.current) : undefined),
            isEqual: Object.is
          })
      });
    }) as ModelCore<TStored, TInput>['use']['first'],
    where: options.whereRead,
    byIds: ((ids: readonly string[] | null | undefined, readOptions: ProjectionOptions<TStored, Record<string, unknown>> = {}) => {
      const resolvedIds = (ids ?? []).map(id => String(id));
      validateProjectionOptions(readOptions, `${options.modelId}.use.byIds`);
      const optionsRef = useRef(readOptions);
      const gateRef = useRef(createProjectionGate<TStored, Record<string, unknown>>());
      const resultRef = useRef<{ rows: Record<string, unknown>[]; byId: ReadonlyMap<string, Record<string, unknown>> } | null>(null);
      optionsRef.current = readOptions;
      return useLiveRead(
        () => {
          const sources: TStored[] = [];
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
        },
        resolvedIds.map(id => options.rowDep(id)),
        Object.is
      );
    }) as ModelCore<TStored, TInput>['use']['byIds'],
    count: function useCount(where) {
      return useIncrementalRead({
        signature: incrementalSignature('count', options.modelId, where),
        deps: [options.modelDep],
        create: () =>
          createModelReadEngine({
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
    related: ((id: string | null | undefined, relationName: string, readOptions: ProjectionOptions<StoredRowShape, Record<string, unknown>> = {}): unknown => {
      const relation = resolvedRelations()[relationName];
      if (!relation) throw new Error(`${options.modelName} has no relation ${relationName}`);
      if (relation.kind === 'hasMany') {
        return useProjectedLiveRows(
          () => (id == null ? EMPTY_ROWS : (relation.model.where({ [relation.foreignKey]: id }) as StoredRowShape[])),
          id == null ? [] : [options.rowDep(id), { kind: 'model', model: relation.model.modelId }],
          readOptions,
          `${options.modelId}.use.related`
        );
      }
      let compute: () => unknown;
      let deps: Dependency[];
      let isEqual: (a: unknown, b: unknown) => boolean = Object.is;
      if (relation.kind === 'belongsTo') {
        const parentIdOf = (): string | null => {
          const child = id == null ? undefined : planes().entityState.read(id);
          const value = child?.[relation.foreignKey];
          return typeof value === 'string' && value.length > 0 ? value : null;
        };
        compute = () => {
          const parentId = parentIdOf();
          return parentId ? relation.model.find(parentId) : undefined;
        };
        const parentId = parentIdOf();
        deps = id == null ? [] : [options.rowDep(id, [relation.foreignKey]), ...(parentId ? [{ kind: 'row' as const, model: relation.model.modelId, id: parentId }] : [])];
      } else if (relation.kind === 'hasOne') {
        const comparator = relation.comparator as ((left: StoredRowShape, right: StoredRowShape) => number) | undefined;
        compute = () => {
          if (id == null) return undefined;
          return pickLowestRow(relation.model.where({ [relation.foreignKey]: id }) as StoredRowShape[], comparator);
        };
        deps = id == null ? [] : [options.rowDep(id), { kind: 'model', model: relation.model.modelId }];
      } else {
        const idsOf = (): string[] => {
          const source = id == null ? undefined : planes().entityState.read(id);
          if (!source) return [];
          const selected = relation.ids(source);
          return (Array.isArray(selected) ? selected : [selected]).flatMap(targetId => (targetId == null ? [] : [String(targetId)]));
        };
        compute = () => idsOf().flatMap(targetId => {
          const row = relation.model.find(targetId);
          return row ? [row] : [];
        });
        deps = id == null ? [] : [options.rowDep(id), ...idsOf().map(targetId => ({ kind: 'row' as const, model: relation.model.modelId, id: targetId }))];
        isEqual = (left, right) => Array.isArray(left) && Array.isArray(right) && arraysShallowEqual(left, right);
      }
      return useLiveRead(compute, deps, isEqual);
    }) as ModelCore<TStored, TInput>['use']['related']
  };
};
