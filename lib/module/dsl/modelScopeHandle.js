"use strict";

import { invalidateModel } from "../core/invalidationRegistry.js";
import { noteDataLoss } from "../core/diagnostics.js";
import { registerInternalScopeHandle } from "../core/internalHandles.js";
import { compositeKey } from "../core/serialize.js";
import { useScopeReadCount, useScopeReadRows, useScopeReadWindowRows } from "../read/scopeReadEngine.js";
import { useRef, useState } from 'react';
import { getDbRuntimeConfig } from "./configure.js";
import { compareRowsBySpec } from "../core/ordering.js";
import { keyAfter, keyBefore, keysForSequence } from "../core/orderKey.js";
const matchesMemberPredicate = (spec, row) => spec?.member?.(row) ?? true;
export const createModelScopeHandle = options => {
  const {
    planes
  } = options.context;
  return scopeName => {
    const spec = (options.scopes ?? {})[scopeName];
    const planScope = (scopeKey, liveRows, coverage, planOptions) => {
      let incoming = liveRows.map(({
        row
      }) => ({
        id: String(row.id)
      }));
      if (spec?.sort && spec.sort !== 'server-order') {
        /** Sorted scopes: order keys are born HERE, on planning - the plane and the store only carry them. */
        const compare = compareRowsBySpec(spec.sort);
        const rowsById = new Map();
        for (const {
          row
        } of liveRows) {
          try {
            const stored = options.normalize(row);
            rowsById.set(String(stored.id), stored);
          } catch {
            /* keyless rows fall to the reconcile tail */
          }
        }
        if (coverage === 'page' && planOptions?.resetOrder === true) {
          const incomingIds = new Set(incoming.map(item => item.id));
          for (const entry of planes().scopeIndex.read(scopeKey).entries) {
            if (incomingIds.has(entry.id)) continue;
            incoming.push({
              id: entry.id
            });
            const stored = planes().entityState.read(entry.id);
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
            return row ? [{
              orderKey: entry.orderKey,
              row
            }] : [];
          });
          incoming = incoming.map(item => {
            if (memberIds.has(item.id)) return item;
            const row = rowsById.get(item.id);
            if (!row) return item;
            let lower = 0;
            let upper = anchors.length;
            while (lower < upper) {
              const middle = Math.floor((lower + upper) / 2);
              if (compare(anchors[middle].row, row) < 0) lower = middle + 1;else upper = middle;
            }
            const orderKey = keysForSequence(1, anchors[lower - 1]?.orderKey, anchors[lower]?.orderKey)[0];
            anchors.splice(lower, 0, {
              orderKey,
              row
            });
            return {
              ...item,
              orderKey
            };
          });
        }
      }
      const reconciliation = planes().scopeIndex.reconcileNext(scopeKey, coverage, incoming, planOptions);
      let {
        next
      } = reconciliation;
      const {
        detachedIds
      } = reconciliation;
      if (detachedIds.length > 0) noteDataLoss('scope-complete-detach', options.modelId, detachedIds.length);
      const maxRows = spec?.retention?.maxRows;
      if (maxRows != null && (planOptions?.resetOrder === true || coverage === 'complete') && next.entries.length > maxRows) {
        const trimmed = planes().scopeIndex.trimValue(next, maxRows);
        if (trimmed.trimmedIds.length > 0) noteDataLoss('scope-retention-trim', options.modelId, trimmed.trimmedIds.length);
        next = trimmed.next;
      }
      return {
        kind: 'scope',
        model: options.modelId,
        scopeKey,
        next
      };
    };
    const planApply = (scopeValue, rows, coverage, planOptions) => {
      const liveRows = rows.filter(({
        row
      }) => options.isPlanRow(row)).filter(({
        row
      }) => !planes().entityState.isTombstoned(String(row.id)));
      const requestedScopeKey = options.keyForScope(scopeName, scopeValue);
      const split = options.splitCorrelatedRows(liveRows.map(({
        row
      }) => row));
      const rowOps = [{
        kind: 'upsert',
        model: options.modelId,
        rows: split.plain
      }, ...split.replaceOps];
      if (!spec?.by) return [...rowOps, planScope(requestedScopeKey, liveRows, coverage, planOptions)];
      const rowsByScope = new Map();
      for (const entry of liveRows) {
        if (!matchesMemberPredicate(spec, entry.row)) continue;
        const derivedValue = options.scopeValueFromRow(spec.by, entry.row);
        if (!derivedValue) continue;
        const derivedKey = options.keyForScope(scopeName, derivedValue);
        const group = rowsByScope.get(derivedKey) ?? [];
        group.push(entry);
        rowsByScope.set(derivedKey, group);
      }
      const requestedRows = rowsByScope.get(requestedScopeKey) ?? [];
      rowsByScope.delete(requestedScopeKey);
      return [...rowOps, planScope(requestedScopeKey, requestedRows, coverage, planOptions), ...[...rowsByScope].map(([scopeKey, scopeRows]) => planScope(scopeKey, scopeRows, 'delta'))];
    };
    const useScopeRows = (scopeValue, readOptions = {}) => {
      const scopeKey = scopeValue === null ? null : options.keyForScope(scopeName, scopeValue);
      options.useScopeAccess(scopeKey);
      return useScopeReadRows(options.modelId, scopeKey, options.applyTarget.scopeSortMeta(scopeKey ?? compositeKey(scopeName, '')), () => scopeKey == null || planes().scopeIndex.read(scopeKey).generation > 0, readOptions);
    };
    const scopeHandle = {
      modelId: options.modelId,
      use: useScopeRows,
      useFirst: (scopeValue, readOptions = {}) => useScopeRows(scopeValue, readOptions)[0],
      useWindow: (scopeValue, readOptions = {}) => {
        const pageSize = readOptions?.pageSize ?? getDbRuntimeConfig().defaults?.pageSize ?? 20;
        const scopeKey = scopeValue === null ? null : options.keyForScope(scopeName, scopeValue);
        const windowStateRef = useRef({
          scopeKey,
          size: pageSize
        });
        const [, setWindowRevision] = useState(0);
        if (windowStateRef.current.scopeKey !== scopeKey) windowStateRef.current = {
          scopeKey,
          size: pageSize
        };
        const windowSize = windowStateRef.current.size;
        options.useScopeAccess(scopeKey);
        const window = useScopeReadWindowRows(options.modelId, scopeKey, options.applyTarget.scopeSortMeta(scopeKey ?? compositeKey(scopeName, '')), windowSize, () => scopeKey == null || planes().scopeIndex.read(scopeKey).generation > 0, readOptions);
        return {
          rows: window.rows,
          totalCount: window.totalCount,
          hasMore: window.totalCount > windowSize,
          isPreviousData: window.isPreviousData,
          resolved: window.resolved,
          fetchNextPage: () => {
            windowStateRef.current = windowStateRef.current.scopeKey === scopeKey ? {
              ...windowStateRef.current,
              size: windowStateRef.current.size + pageSize
            } : {
              scopeKey,
              size: pageSize + pageSize
            };
            setWindowRevision(current => current + 1);
          }
        };
      },
      useCount: scopeValue => {
        const scopeKey = scopeValue === null ? null : options.keyForScope(scopeName, scopeValue);
        options.useScopeAccess(scopeKey);
        return useScopeReadCount(options.modelId, scopeKey, options.applyTarget.scopeSortMeta(scopeKey ?? compositeKey(scopeName, '')));
      },
      invalidate: scopeValue => {
        invalidateModel(options.modelId, scopeValue);
      },
      read: scopeValue => {
        const scopeKey = options.keyForScope(scopeName, scopeValue);
        planes().scopeIndex.noteAccess(scopeKey);
        return options.scopeSortedRows(scopeName, scopeValue);
      },
      issueSequence: (scopeValue, field) => {
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
      seed: (scopeValue, rows) => {
        const liveRows = rows.filter(options.isPlanRow).filter(row => !planes().entityState.isTombstoned(String(row.id))).map(row => ({
          row: row
        }));
        options.applyEvent([{
          kind: 'upsert',
          model: options.modelId,
          rows: liveRows.map(entry => entry.row)
        }, planScope(options.keyForScope(scopeName, scopeValue), liveRows, 'complete', {
          resetOrder: true
        })]);
      }
    };
    registerInternalScopeHandle(scopeHandle, {
      apply: (scopeValue, rows, coverage, planOptions) => {
        options.applySnapshot(planApply(scopeValue, rows.map(row => ({
          row: row
        })), coverage, planOptions));
      },
      planApply,
      key: scopeValue => options.keyForScope(scopeName, scopeValue),
      isServerOrder: () => !spec?.sort || spec.sort === 'server-order',
      planPlacement: (scopeValue, id, position) => {
        const scopeKey = options.keyForScope(scopeName, scopeValue);
        const entries = planes().scopeIndex.read(scopeKey).entries;
        const orderKey = position === 'prepend' ? keyBefore(entries[0]?.orderKey) : keyAfter(entries.at(-1)?.orderKey);
        return [{
          kind: 'scope-delta',
          model: options.modelId,
          scopeKey,
          append: [{
            id,
            orderKey
          }],
          detach: []
        }];
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
//# sourceMappingURL=modelScopeHandle.js.map