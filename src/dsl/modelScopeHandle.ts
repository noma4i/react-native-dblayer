import { sortBy } from 'es-toolkit';
import type { ApplyTarget } from '../core/apply/transaction';
import type { Dependency } from '../core/apply/commitBus';
import type { JournalOp } from '../core/apply/journal';
import { invalidateModel } from '../core/invalidationRegistry';
import { noteDataLoss } from '../core/diagnostics';
import { registerInternalScopeHandle } from '../core/internalHandles';
import { compositeKey } from '../core/serialize';
import { useScopeReadRows, useScopeReadWindowRows } from '../read/scopeReadEngine';
import type { KeepPreviousOption } from '../read/scopeRetention';
import { useLiveRead } from '../read/useLiveRead';
import type { ScopeHandle, StoredRowShape } from '../types/dsl.model.types';
import { useRef, useState } from 'react';
import { getDbRuntimeConfig } from './configure';
import type { ModelContext } from './modelContext';
import { sortRowsBySpec } from './modelReadAccess';
import type { ScopeCoverage, ScopeSpec } from './scope';
import type { ProjectionOptions } from '../read/projectionGate';

const matchesMemberPredicate = <TRow,>(spec: { member?: (row: TRow) => boolean } | undefined, row: TRow): boolean => spec?.member?.(row) ?? true;

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
  applySnapshot(ops: JournalOp[]): void;
  applyEvent(ops: JournalOp[]): void;
}) => {
  const { planes } = options.context;
  return (scopeName: string): ScopeHandle<TStored, Record<string, unknown>, TInput> => {
    const spec = (options.scopes ?? {})[scopeName] as ScopeSpec<TStored>;
    const planScope = (
      scopeKey: string,
      liveRows: Array<{ row: Record<string, unknown>; edge?: Record<string, unknown> }>,
      coverage: ScopeCoverage,
      planOptions?: { resetOrder?: boolean }
    ): JournalOp => {
      let { next, detachedIds } = planes().scopeIndex.reconcileNext(
        scopeKey,
        coverage,
        liveRows.map(({ row, edge }) => ({ id: String(row.id), edge })),
        planOptions
      );
      if (detachedIds.length > 0) noteDataLoss('scope-complete-detach', options.modelId, detachedIds.length);
      const maxRows = spec?.retention?.maxRows;
      if (maxRows != null && (planOptions?.resetOrder === true || coverage === 'complete') && next.entries.length > maxRows) {
        if (spec.sort && spec.sort !== 'server-order') {
          const incomingById = new Map(
            liveRows.flatMap(({ row }) => {
              try {
                const stored = options.normalize(row);
                return [[String(stored.id), stored] as const];
              } catch {
                return [];
              }
            })
          );
          const rowsById = new Map(
            next.entries.flatMap(entry => {
              const row = incomingById.get(entry.id) ?? planes().entityState.read(entry.id);
              return row ? [[entry.id, row] as const] : [];
            })
          );
          const ordered = sortRowsBySpec([...rowsById.values()], spec.sort);
          const positions = new Map(ordered.map((row, index) => [String(row.id), index]));
          next = {
            ...next,
            entries: sortBy(next.entries, [entry => positions.get(entry.id) ?? Number.MAX_SAFE_INTEGER])
          };
        }
        const trimmed = planes().scopeIndex.trimValue(next, maxRows);
        if (trimmed.trimmedIds.length > 0) noteDataLoss('scope-retention-trim', options.modelId, trimmed.trimmedIds.length);
        next = trimmed.next;
      }
      return { kind: 'scope', model: options.modelId, scopeKey, next };
    };
    const planApply = (
      scopeValue: unknown,
      rows: Array<{ row: Record<string, unknown>; edge?: Record<string, unknown> }>,
      coverage: ScopeCoverage,
      planOptions?: { resetOrder?: boolean }
    ): JournalOp[] => {
      const liveRows = rows.filter(({ row }) => options.isPlanRow(row)).filter(({ row }) => !planes().entityState.isTombstoned(String(row.id)));
      const requestedScopeKey = options.keyForScope(scopeName, scopeValue);
      const upsert: JournalOp = { kind: 'upsert', model: options.modelId, rows: liveRows.map(({ row }) => row) };
      if (!spec?.by) return [upsert, planScope(requestedScopeKey, liveRows, coverage, planOptions)];

      const rowsByScope = new Map<string, Array<{ row: Record<string, unknown>; edge?: Record<string, unknown> }>>();
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
      return [upsert, planScope(requestedScopeKey, requestedRows, coverage, planOptions), ...[...rowsByScope].map(([scopeKey, scopeRows]) => planScope(scopeKey, scopeRows, 'delta'))];
    };
    const readScopeRows = (scopeValue: unknown, readOptions: ProjectionOptions<StoredRowShape, Record<string, unknown>> = {}) => {
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
      use: readScopeRows,
      useFirst: (scopeValue: unknown, readOptions: { renderKeys?: readonly string[] } & KeepPreviousOption = {}) =>
        readScopeRows(scopeValue, readOptions as ProjectionOptions<StoredRowShape, Record<string, unknown>>)[0],
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
        return useLiveRead(
          () => (scopeValue === null ? 0 : planes().scopeIndex.read(options.keyForScope(scopeName, scopeValue)).entries.length),
          scopeKey == null ? [] : [options.scopeDep(scopeKey)]
        );
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
          { kind: 'upsert', model: options.modelId, rows: liveRows.map(entry => entry.row) },
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
        const order = position === 'prepend' ? Math.min(0, ...entries.map(entry => entry.order)) - 1 : Math.max(-1, ...entries.map(entry => entry.order)) + 1;
        return [{ kind: 'scope-delta', model: options.modelId, scopeKey, append: [{ id, order }], detach: [] }];
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
