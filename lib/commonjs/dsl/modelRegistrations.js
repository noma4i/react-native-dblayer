"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.registerModelSchema = exports.registerModelRuntime = void 0;
var _commitEnvelope = require("../core/apply/commitEnvelope.js");
var _ordering = require("../core/ordering.js");
var _diagnostics = require("../core/diagnostics.js");
var _reset = require("../core/reset.js");
var _schemaManifest = require("../core/schemaManifest.js");
var _configure = require("./configure.js");
var _mutationRuntime = require("./mutationRuntime.js");
var _defineIngest = require("./defineIngest.js");
var _internalHandles = require("../core/internalHandles.js");
var _maintenanceRegistry = require("./maintenanceRegistry.js");
var _modelMaintenance = require("../utils/modelMaintenance.js");
const registerModelSchema = options => {
  (0, _schemaManifest.registerSchemaDeclaration)({
    id: options.modelId,
    name: options.modelName,
    fields: Object.fromEntries(Object.entries(options.fields).map(([name, field]) => [name, {
      kind: field.kind,
      mode: field.mode,
      hasDefault: field.hasDefault
    }])),
    scopes: Object.fromEntries(Object.entries(options.scopes ?? {}).map(([name, spec]) => {
      const by = spec.by ? Object.fromEntries(Object.entries(spec.by).map(([scopeField, rowField]) => [scopeField, String(rowField)])) : null;
      const sort = spec.member ? 'member' : !spec.sort || spec.sort === 'server-order' ? 'server-order' : (0, _ordering.isMultiFieldSort)(spec.sort) ? spec.sort.map(order => `field:${String(order.field)}:${order.dir}`).join('+') : 'field' in spec.sort ? `field:${String(spec.sort.field)}:${spec.sort.dir}` : 'comparator';
      return [name, {
        by,
        sort
      }];
    }))
  });
};
exports.registerModelSchema = registerModelSchema;
const registerModelRuntime = options => {
  const {
    planes,
    resolvedRelations
  } = options.context;
  const model = options.context.model();
  (0, _internalHandles.registerInternalModelHandle)(model, {
    modelId: options.modelId,
    normalizeRowId: row => options.normalize(row).id,
    readRow: id => planes().entityState.read(id),
    applyRows: rows => options.applySnapshot(options.planRows(rows)),
    applyPatch: (id, patch, operationId) => (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)([{
      kind: 'patch',
      model: options.modelId,
      id: String(id),
      patch,
      operationId
    }])),
    planRows: options.planRows,
    planReplace: options.planReplace,
    captureMembership: options.captureMembership,
    planRestore: options.planRestore,
    relations: resolvedRelations,
    revision: options.context.revision,
    dropTempRowsAfterMs: () => options.maintenance?.dropTempRowsAfterMs
  });
  (0, _defineIngest.registerIngestModel)(options.modelName, model);
  if (options.maintenance) {
    const pendingTempRows = () => {
      const maxAgeMs = options.maintenance?.dropTempRowsAfterMs;
      if (maxAgeMs === undefined) return [];
      const protectedIds = new Set([...(0, _configure.getOperationState)().open().filter(operation => operation.model === options.modelId).flatMap(operation => operation.tempIds), ...modelProtectedTempIds()]);
      const ids = [];
      (0, _modelMaintenance.resolveStaleTempRows)(model, {
        maxAgeMs,
        protectedIds,
        onStale: row => ids.push(row.id)
      });
      if (ids.length === 0) return [];
      (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)([{
        kind: 'destroy',
        model: options.modelId,
        ids,
        tombstone: false
      }]));
      for (const id of ids) (0, _mutationRuntime.clearFailedOptimisticMutation)(options.modelId, id);
      (0, _diagnostics.noteDataLoss)('stale-temp-row-expiry', options.modelId, ids.length);
      return [{
        model: options.modelId,
        task: 'dropTempRows',
        affected: ids.length
      }];
    };
    const modelProtectedTempIds = () => new Set(options.maintenance?.protectTempRows?.() ?? []);
    (0, _maintenanceRegistry.registerModelMaintenance)(options.modelId, {
      boot: () => {
        const reports = [];
        for (const task of options.maintenance?.maxRowsPerScope ?? []) {
          reports.push({
            model: options.modelId,
            task: 'maxRowsPerScope',
            affected: (0, _modelMaintenance.trimRowsPerScope)(model, task.scopeField, task.limit, task.compare, task.protect?.())
          });
        }
        return [...reports, ...pendingTempRows()];
      },
      pendingTempRows,
      protectedTempIds: modelProtectedTempIds
    });
  }
  (0, _reset.registerKeyedReset)(`model:${options.modelId}`, () => {
    options.context.reset();
    // The apply target stays registered: a model must keep working after the kill-switch.
  });
};
exports.registerModelRuntime = registerModelRuntime;
//# sourceMappingURL=modelRegistrations.js.map