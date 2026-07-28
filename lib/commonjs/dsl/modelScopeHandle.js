"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createModelScopeHandle = void 0;
var _esToolkit = require("es-toolkit");
var _invalidationRegistry = require("../core/invalidationRegistry.js");
var _diagnostics = require("../core/diagnostics.js");
var _internalHandles = require("../core/internalHandles.js");
var _serialize = require("../core/serialize.js");
var _scopeReadEngine = require("../read/scopeReadEngine.js");
var _useLiveRead = require("../read/useLiveRead.js");
var _react = require("react");
var _configure = require("./configure.js");
var _modelReadAccess = require("./modelReadAccess.js");
const matchesMemberPredicate = (spec, row) => spec?.member?.(row) ?? true;
const createModelScopeHandle = options => {
  const {
    planes
  } = options.context;
  return scopeName => {
    const spec = (options.scopes ?? {})[scopeName];
    const planScope = (scopeKey, liveRows, coverage, planOptions) => {
      const reconciliation = planes().scopeIndex.reconcileNext(scopeKey, coverage, liveRows.map(({
        row,
        edge
      }) => ({
        id: String(row.id),
        edge
      })), planOptions);
      let {
        next
      } = reconciliation;
      const {
        detachedIds
      } = reconciliation;
      if (detachedIds.length > 0) (0, _diagnostics.noteDataLoss)('scope-complete-detach', options.modelId, detachedIds.length);
      const maxRows = spec?.retention?.maxRows;
      if (maxRows != null && (planOptions?.resetOrder === true || coverage === 'complete') && next.entries.length > maxRows) {
        if (spec.sort && spec.sort !== 'server-order') {
          const incomingById = new Map(liveRows.flatMap(({
            row
          }) => {
            try {
              const stored = options.normalize(row);
              return [[String(stored.id), stored]];
            } catch {
              return [];
            }
          }));
          const rowsById = new Map(next.entries.flatMap(entry => {
            const row = incomingById.get(entry.id) ?? planes().entityState.read(entry.id);
            return row ? [[entry.id, row]] : [];
          }));
          const ordered = (0, _modelReadAccess.sortRowsBySpec)([...rowsById.values()], spec.sort);
          const positions = new Map(ordered.map((row, index) => [String(row.id), index]));
          next = {
            ...next,
            entries: (0, _esToolkit.sortBy)(next.entries, [entry => positions.get(entry.id) ?? Number.MAX_SAFE_INTEGER])
          };
        }
        const trimmed = planes().scopeIndex.trimValue(next, maxRows);
        if (trimmed.trimmedIds.length > 0) (0, _diagnostics.noteDataLoss)('scope-retention-trim', options.modelId, trimmed.trimmedIds.length);
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
      return (0, _scopeReadEngine.useScopeReadRows)(options.modelId, scopeKey, options.applyTarget.scopeSortMeta(scopeKey ?? (0, _serialize.compositeKey)(scopeName, '')), () => scopeKey == null || planes().scopeIndex.read(scopeKey).generation > 0, readOptions);
    };
    const scopeHandle = {
      modelId: options.modelId,
      use: useScopeRows,
      useFirst: (scopeValue, readOptions = {}) => useScopeRows(scopeValue, readOptions)[0],
      useWindow: (scopeValue, readOptions = {}) => {
        const pageSize = readOptions?.pageSize ?? (0, _configure.getDbRuntimeConfig)().defaults?.pageSize ?? 20;
        const scopeKey = scopeValue === null ? null : options.keyForScope(scopeName, scopeValue);
        const windowStateRef = (0, _react.useRef)({
          scopeKey,
          size: pageSize
        });
        const [, setWindowRevision] = (0, _react.useState)(0);
        if (windowStateRef.current.scopeKey !== scopeKey) windowStateRef.current = {
          scopeKey,
          size: pageSize
        };
        const windowSize = windowStateRef.current.size;
        options.useScopeAccess(scopeKey);
        const window = (0, _scopeReadEngine.useScopeReadWindowRows)(options.modelId, scopeKey, options.applyTarget.scopeSortMeta(scopeKey ?? (0, _serialize.compositeKey)(scopeName, '')), windowSize, () => scopeKey == null || planes().scopeIndex.read(scopeKey).generation > 0, readOptions);
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
        return (0, _useLiveRead.useLiveRead)(() => scopeValue === null ? 0 : planes().scopeIndex.read(options.keyForScope(scopeName, scopeValue)).entries.length, scopeKey == null ? [] : [options.scopeDep(scopeKey)]);
      },
      invalidate: scopeValue => {
        (0, _invalidationRegistry.invalidateModel)(options.modelId, scopeValue);
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
        const issuedKey = (0, _serialize.compositeKey)(options.modelId, scopeKey, field);
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
    (0, _internalHandles.registerInternalScopeHandle)(scopeHandle, {
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
        const order = position === 'prepend' ? Math.min(0, ...entries.map(entry => entry.order)) - 1 : Math.max(-1, ...entries.map(entry => entry.order)) + 1;
        return [{
          kind: 'scope-delta',
          model: options.modelId,
          scopeKey,
          append: [{
            id,
            order
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
exports.createModelScopeHandle = createModelScopeHandle;
//# sourceMappingURL=modelScopeHandle.js.map