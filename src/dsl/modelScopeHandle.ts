import type { ApplyTarget, Dependency, KeepPreviousOption, ModelContext, ScopeCoverage, ScopeHandle, ScopeSpec, StoredRowShape, ProjectionOptions, WriteOp } from '../types';
import { invalidateModel } from '../core/invalidationRegistry';
import { noteDataLoss } from '../core/diagnostics';
import { registerInternalScopeHandle } from '../core/internalHandles';
import { compositeKey } from '../core/serialize';
import { useScopeReadCount, useScopeReadRows, useScopeReadWindowRows } from '../read/scopeReadEngine';

import { useRef, useState } from 'react';
import { getDbRuntimeConfig } from './configure';
import { compareRowsBySpec } from '../core/ordering';
import { keyAfter, keyBefore, keysForSequence } from '../core/orderKey';

const matchesMemberPredicate = <TRow>(spec: { member?: (row: TRow) => boolean } | undefined, row: TRow): boolean => spec?.member?.(row) ?? true;

export const createModelScopeHandle = <TStored extends { id: string } & Record<string, unknown>, TInput>(options: {
  modelId: string;
  modelName: string;
  context: ModelContext<TStored>;
  scopes: Record<string, ScopeSpec<TStored>> | undefined;
  keyForScope(scopeName: string, scopeValue: unknown): string;
  scopeValueFromRow(by: Record<string, string>, row: Record<string, unknown>): Record<string, unknown> | null;
  isPlanRow(input: unknown): boolean;
  normalize(input: unknown): TStored;
  applyTarget: Pick<ApplyTarget, 'scopeSortMeta'>;
  scopeDep(scopeKey: string): Dependency;
  useScopeAccess(scopeKey: string | null): void;
  scopeSortedRows(scopeName: string, scopeValue: unknown): TStored[];
  planRows(rows: unknown[]): WriteOp[];
  applySnapshot(ops: WriteOp[]): void;
  applyEvent(ops: WriteOp[]): void;
}) => {
  const { planes } = options.context;
  return (scopeName: string): ScopeHandle<TStored, Record<string, unknown>, TInput> => {
    const spec = options.scopes![scopeName] as ScopeSpec<TStored>;
    const planScope = (
      scopeKey: string,
      liveRows: Array<{ row: Record<string, unknown> }>,
      coverage: ScopeCoverage,
      planOptions?: { resetOrder?: boolean }
    ): WriteOp => {
      let incoming = liveRows.map(({ row }) => ({ id: String(row.id) }) as { id: string; orderKey?: string });
      if (spec?.sort && spec.sort !== 'server-order') {
        /** Sorted scopes: order keys are born HERE, on planning - the plane and the store only carry them. */
        const compare = compareRowsBySpec(spec.sort);
        const rowsById = new Map<string, TStored>();
        for (const { row } of liveRows) {
          const stored = options.normalize(row);
          rowsById.set(String(stored.id), stored);
        }
        if (coverage === 'page' && planOptions?.resetOrder === true) {
          const incomingIds = new Set(incoming.map(item => item.id));
          for (const entry of planes().scopeIndex.read(scopeKey).entries) {
            if (incomingIds.has(entry.id)) continue;
            incoming.push({ id: entry.id });
            const stored = planes().entityState.read(entry.id) as TStored | undefined;
            if (stored) rowsById.set(entry.id, stored);
          }
        }
        if (coverage === 'complete' || planOptions?.resetOrder === true) {
          incoming = [...incoming].sort((left, right) => {
            const a = rowsById.get(left.id);
            const b = rowsById.get(right.id);
            return a && b ? compare(a, b) : 0;
          });
        } else {
          const entries = planes().scopeIndex.read(scopeKey).entries;
          const memberIds = new Set(entries.map(entry => entry.id));
          const anchors = entries.flatMap(entry => {
            const row = rowsById.get(entry.id) ?? planes().entityState.read(entry.id);
            return row ? [{ orderKey: entry.orderKey, row }] : [];
          });
          incoming = incoming.map(item => {
            if (memberIds.has(item.id)) return item;
            const row = rowsById.get(item.id)!;
            let lower = 0;
            let upper = anchors.length;
            while (lower < upper) {
              const middle = Math.floor((lower + upper) / 2);
              if (compare(anchors[middle]!.row, row) < 0) lower = middle + 1;
              else upper = middle;
            }
            const orderKey = keysForSequence(1, anchors[lower - 1]?.orderKey, anchors[lower]?.orderKey)[0]!;
            anchors.splice(lower, 0, { orderKey, row });
            return { ...item, orderKey };
          });
        }
      }
      const reconciliation = planes().scopeIndex.reconcileNext(scopeKey, coverage, incoming, planOptions);
      let { next } = reconciliation;
      const { detachedIds } = reconciliation;
      if (detachedIds.length > 0) noteDataLoss('scope-complete-detach', options.modelId, detachedIds.length);
      const maxRows = spec?.retention?.maxRows;
      if (maxRows != null && (planOptions?.resetOrder === true || coverage === 'complete') && next.entries.length > maxRows) {
        const trimmed = planes().scopeIndex.trimValue(next, maxRows);
        if (trimmed.trimmedIds.length > 0) noteDataLoss('scope-retention-trim', options.modelId, trimmed.trimmedIds.length);
        next = trimmed.next;
      }
      return { kind: 'scope', model: options.modelId, scopeKey, next };
    };
    const planApply = (
      scopeValue: unknown,
      rows: Array<{ row: Record<string, unknown> }>,
      coverage: ScopeCoverage,
      planOptions?: { resetOrder?: boolean }
    ): WriteOp[] => {
      const liveRows = rows.filter(({ row }) => options.isPlanRow(row)).filter(({ row }) => !planes().entityState.isTombstoned(String(row.id)));
      const requestedScopeKey = options.keyForScope(scopeName, scopeValue);
      const rowOps = options.planRows(liveRows.map(({ row }) => row));
      if (!spec?.by) return [...rowOps, planScope(requestedScopeKey, liveRows, coverage, planOptions)];

      const rowsByScope = new Map<string, Array<{ row: Record<string, unknown> }>>();
      for (const entry of liveRows) {
        if (!matchesMemberPredicate<TStored>(spec, entry.row as TStored)) continue;
        const derivedValue = options.scopeValueFromRow(spec.by, entry.row);
        if (!derivedValue) continue;
        const derivedKey = options.keyForScope(scopeName, derivedValue);
        const group = rowsByScope.get(derivedKey) ?? [];
        group.push(entry);
        rowsByScope.set(derivedKey, group);
      }
      const requestedRows = rowsByScope.get(requestedScopeKey) ?? [];
      rowsByScope.delete(requestedScopeKey);
      return [
        ...rowOps,
        planScope(requestedScopeKey, requestedRows, coverage, planOptions),
        ...[...rowsByScope].map(([scopeKey, scopeRows]) => planScope(scopeKey, scopeRows, 'delta'))
      ];
    };
    const useScopeRows = (scopeValue: unknown, readOptions: ProjectionOptions<StoredRowShape, Record<string, unknown>> = {}) => {
      const scopeKey = scopeValue === null ? null : options.keyForScope(scopeName, scopeValue);
      options.useScopeAccess(scopeKey);
      return useScopeReadRows(
        options.modelId,
        scopeKey,
        options.applyTarget.scopeSortMeta(scopeKey ?? compositeKey(scopeName, '')),
        () => scopeKey == null || planes().scopeIndex.read(scopeKey).generation > 0,
        readOptions
      );
    };
    const scopeHandle = {
      modelId: options.modelId,
      use: useScopeRows,
      useFirst: (scopeValue: unknown, readOptions: { renderKeys?: readonly string[] } & KeepPreviousOption = {}) =>
        useScopeRows(scopeValue, readOptions as ProjectionOptions<StoredRowShape, Record<string, unknown>>)[0],
      useWindow: (scopeValue: unknown, readOptions: { pageSize?: number; keepPrevious?: boolean } & ProjectionOptions<StoredRowShape, Record<string, unknown>> = {}) => {
        const pageSize = readOptions?.pageSize ?? getDbRuntimeConfig().defaults?.pageSize ?? 20;
        const scopeKey = scopeValue === null ? null : options.keyForScope(scopeName, scopeValue);
        const windowStateRef = useRef({ scopeKey, size: pageSize });
        const [, setWindowRevision] = useState(0);
        if (windowStateRef.current.scopeKey !== scopeKey) windowStateRef.current = { scopeKey, size: pageSize };
        const windowSize = windowStateRef.current.size;
        options.useScopeAccess(scopeKey);
        const window = useScopeReadWindowRows(
          options.modelId,
          scopeKey,
          options.applyTarget.scopeSortMeta(scopeKey ?? compositeKey(scopeName, '')),
          windowSize,
          () => scopeKey == null || planes().scopeIndex.read(scopeKey).generation > 0,
          readOptions
        );
        return {
          rows: window.rows,
          totalCount: window.totalCount,
          hasMore: window.totalCount > windowSize,
          isPreviousData: window.isPreviousData,
          resolved: window.resolved,
          fetchNextPage: () => {
            windowStateRef.current =
              windowStateRef.current.scopeKey === scopeKey ? { ...windowStateRef.current, size: windowStateRef.current.size + pageSize } : { scopeKey, size: pageSize + pageSize };
            setWindowRevision(current => current + 1);
          }
        };
      },
      useCount: (scopeValue: unknown) => {
        const scopeKey = scopeValue === null ? null : options.keyForScope(scopeName, scopeValue);
        options.useScopeAccess(scopeKey);
        return useScopeReadCount(options.modelId, scopeKey, options.applyTarget.scopeSortMeta(scopeKey ?? compositeKey(scopeName, '')));
      },
      invalidate: (scopeValue?: unknown) => {
        invalidateModel(options.modelId, scopeValue);
      },
      read: (scopeValue: unknown) => {
        const scopeKey = options.keyForScope(scopeName, scopeValue);
        planes().scopeIndex.noteAccess(scopeKey);
        return options.scopeSortedRows(scopeName, scopeValue);
      },
      issueSequence: (scopeValue: unknown, field: keyof TStored & string) => {
        if (scopeValue === null) throw new Error(`${options.modelName}.${scopeName}.issueSequence requires a scope value`);
        const scopeKey = options.keyForScope(scopeName, scopeValue);
        planes().scopeIndex.noteAccess(scopeKey);
        const maxFieldValue = options.scopeSortedRows(scopeName, scopeValue).reduce((maximum, row) => {
          const value = row[field];
          return typeof value === 'number' && value > maximum ? value : maximum;
        }, 0);
        const issuedKey = compositeKey(options.modelId, scopeKey, field);
        const maxIssuedThisSession = options.context.issuedScopeSequence(issuedKey) ?? 0;
        const next = Math.max(maxFieldValue, maxIssuedThisSession) + 1;
        options.context.setIssuedScopeSequence(issuedKey, next);
        return next;
      },
      seed: (scopeValue: unknown, rows: TInput[]) => {
        const liveRows = rows
          .filter(options.isPlanRow)
          .filter(row => !planes().entityState.isTombstoned(String((row as { id: unknown }).id)))
          .map(row => ({ row: row as Record<string, unknown> }));
        options.applyEvent([
          ...options.planRows(liveRows.map(entry => entry.row)),
          planScope(options.keyForScope(scopeName, scopeValue), liveRows, 'complete', { resetOrder: true })
        ]);
      }
    } as ScopeHandle<TStored, Record<string, unknown>, TInput>;
    registerInternalScopeHandle(scopeHandle, {
      apply: (scopeValue, rows, coverage, planOptions) => {
        options.applySnapshot(
          planApply(
            scopeValue,
            rows.map(row => ({ row: row as Record<string, unknown> })),
            coverage,
            planOptions
          )
        );
      },
      planApply,
      key: scopeValue => options.keyForScope(scopeName, scopeValue),
      isServerOrder: () => !spec?.sort || spec.sort === 'server-order',
      planPlacement: (scopeValue, id, position) => {
        const scopeKey = options.keyForScope(scopeName, scopeValue);
        const entries = planes().scopeIndex.read(scopeKey).entries;
        const orderKey = position === 'prepend' ? keyBefore(entries[0]?.orderKey) : keyAfter(entries.at(-1)?.orderKey);
        return [{ kind: 'scope-delta', model: options.modelId, scopeKey, append: [{ id, orderKey }], detach: [] }];
      },
      readRows: scopeValue => options.scopeSortedRows(scopeName, scopeValue),
      isResolved: scopeValue => planes().scopeIndex.read(options.keyForScope(scopeName, scopeValue)).generation > 0,
      noteAccess: scopeValue => {
        planes().scopeIndex.noteAccess(options.keyForScope(scopeName, scopeValue));
      }
    });
    return scopeHandle;
  };
};
