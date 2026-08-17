"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createModelScopeHandle = void 0;
var _invalidationRegistry = require("../core/invalidationRegistry.js");
var _diagnostics = require("../core/diagnostics.js");
var _internalHandles = require("../core/internalHandles.js");
var _serialize = require("../core/serialize.js");
var _scopeReadEngine = require("../read/scopeReadEngine.js");
var _react = require("react");
var _configure = require("./configure.js");
var _ordering = require("../core/ordering.js");
var _orderKey = require("../core/orderKey.js");
const matchesMemberPredicate = (spec, row) => spec?.member?.(row) ?? true;
const createModelScopeHandle = options => {
  const {
    planes
  } = options.context;
  const dropTombstonedRows = (entries, rowOf) => entries.filter(entry => {
    if (!planes().entityState.isTombstoned(options.normalize(rowOf(entry)).id)) return true;
    (0, _diagnostics.noteTombstoneWriteDrop)();
    return false;
  });
  return scopeName => {
    const spec = options.scopes[scopeName];
    const planScope = (scopeKey, liveRows, coverage, planOptions) => {
      let incoming = liveRows.map(({
        row
      }) => ({
        id: options.normalize(row).id
      }));
      if (spec?.sort && spec.sort !== 'server-order') {
        /** Sorted scopes: order keys are born HERE, on planning - the plane and the store only carry them. */
        const compare = (0, _ordering.compareRowsBySpec)(spec.sort);
        const rowsById = new Map();
        for (const {
          row
        } of liveRows) {
          const stored = options.normalize(row);
          rowsById.set(String(stored.id), stored);
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
            let lower = 0;
            let upper = anchors.length;
            while (lower < upper) {
              const middle = Math.floor((lower + upper) / 2);
              if (compare(anchors[middle].row, row) < 0) lower = middle + 1;else upper = middle;
            }
            const orderKey = (0, _orderKey.keysForSequence)(1, anchors[lower - 1]?.orderKey, anchors[lower]?.orderKey)[0];
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
      // Rows held by open operations survive snapshot reconciliation and retention: the ledger is
      // the one protection root (TTL, replay cleanup, and both planning cuts below).
      const heldRowIds = coverage === 'complete' || planOptions?.resetOrder === true ? (0, _configure.getOperationState)().openRowIdsFor(options.modelId) : undefined;
      const protectedIds = heldRowIds !== undefined && heldRowIds.size > 0 ? new Set([...heldRowIds].filter(id => !planOptions?.releasedIds?.has(id))) : undefined;
      const reconciliation = planes().scopeIndex.reconcileNext(scopeKey, coverage, incoming, {
        ...planOptions,
        protectedIds
      });
      let {
        next
      } = reconciliation;
      const {
        detachedIds
      } = reconciliation;
      (0, _diagnostics.noteDataLoss)('scope-complete-detach', options.modelId, detachedIds.length);
      const maxRows = spec?.retention?.maxRows;
      if (maxRows != null && (planOptions?.resetOrder === true || coverage === 'complete') && next.entries.length > maxRows) {
        const trimmed = planes().scopeIndex.trimValue(next, maxRows, protectedIds);
        (0, _diagnostics.noteDataLoss)('scope-retention-trim', options.modelId, trimmed.trimmedIds.length);
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
      const liveRows = dropTombstonedRows(rows.filter(({
        row
      }) => options.admitPlanRow(row) !== undefined), ({
        row
      }) => row);
      const requestedScopeKey = options.keyForScope(scopeName, scopeValue);
      const rowOps = options.planRows(liveRows.map(({
        row
      }) => row));
      const releasedIds = new Set(rowOps.flatMap(op => op.kind === 'destroy' && op.origin === 'replace' ? op.ids : []));
      const scopePlanOptions = releasedIds.size > 0 ? {
        ...planOptions,
        releasedIds
      } : planOptions;
      if (!spec?.by) return [...rowOps, planScope(requestedScopeKey, liveRows, coverage, scopePlanOptions)];
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
      return [...rowOps, planScope(requestedScopeKey, requestedRows, coverage, scopePlanOptions), ...[...rowsByScope].map(([scopeKey, scopeRows]) => planScope(scopeKey, scopeRows, 'delta'))];
    };
    /** One prelude for every reactive scope read: key resolution, access note, sort meta and the resolved witness come from one place. */
    const useScopeRead = scopeValue => {
      const scopeKey = scopeValue === null ? null : options.keyForScope(scopeName, scopeValue);
      options.useScopeAccess(scopeKey);
      return {
        scopeKey,
        sortMeta: options.applyTarget.scopeSortMeta(scopeKey ?? (0, _serialize.compositeKey)(scopeName, '')),
        isResolved: () => scopeKey == null || planes().scopeIndex.read(scopeKey).generation > 0
      };
    };
    const useScopeRows = (scopeValue, readOptions = {}) => {
      const read = useScopeRead(scopeValue);
      return (0, _scopeReadEngine.useScopeReadRows)(options.modelId, read.scopeKey, read.sortMeta, read.isResolved, readOptions);
    };
    const scopeHandle = {
      modelId: options.modelId,
      use: useScopeRows,
      useFirst: (scopeValue, readOptions = {}) => useScopeRows(scopeValue, readOptions)[0],
      useWindow: (scopeValue, readOptions = {}) => {
        const pageSize = readOptions?.pageSize ?? (0, _configure.getDbRuntimeConfig)().defaults?.pageSize ?? 20;
        const read = useScopeRead(scopeValue);
        const scopeKey = read.scopeKey;
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
        const window = (0, _scopeReadEngine.useScopeReadWindowRows)(options.modelId, scopeKey, read.sortMeta, windowSize, read.isResolved, readOptions);
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
        const read = useScopeRead(scopeValue);
        return (0, _scopeReadEngine.useScopeReadCount)(options.modelId, read.scopeKey, read.sortMeta, read.isResolved);
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
        const liveRows = dropTombstonedRows(rows.filter(row => options.admitPlanRow(row) !== undefined), row => row).map(row => ({
          row: row
        }));
        options.applyEvent([...options.planRows(liveRows.map(entry => entry.row)), planScope(options.keyForScope(scopeName, scopeValue), liveRows, 'complete', {
          resetOrder: true
        })]);
      }
    };
    (0, _internalHandles.registerInternalScopeHandle)(scopeHandle, {
      normalizeRowId: row => options.normalize(row).id,
      admitRowId: row => options.admitPlanRow(row)?.id,
      apply: (scopeValue, rows, coverage, planOptions) => {
        options.applySnapshot(planApply(scopeValue, rows.map(row => ({
          row: row
        })), coverage, planOptions));
      },
      planApply,
      normalize: scopeValue => options.normalizeScopeValue(scopeName, scopeValue),
      isComplete: scopeValue => options.isScopeValueComplete(scopeName, scopeValue),
      key: scopeValue => options.keyForScope(scopeName, scopeValue),
      isServerOrder: () => !spec?.sort || spec.sort === 'server-order',
      planPlacement: (scopeValue, id, position) => {
        const scopeKey = options.keyForScope(scopeName, scopeValue);
        const entries = planes().scopeIndex.read(scopeKey).entries;
        const orderKey = position === 'prepend' ? (0, _orderKey.keyBefore)(entries[0]?.orderKey) : (0, _orderKey.keyAfter)(entries.at(-1)?.orderKey);
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
exports.createModelScopeHandle = createModelScopeHandle;
//# sourceMappingURL=modelScopeHandle.js.map