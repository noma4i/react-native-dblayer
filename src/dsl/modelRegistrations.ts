import { createCommitEnvelope } from '../core/apply/commitEnvelope';
import { isMultiFieldSort } from '../core/ordering';
import { noteDataLoss } from '../core/diagnostics';
import { registerKeyedReset } from '../core/reset';
import { registerSchemaDeclaration } from '../core/schemaManifest';
import { getApplyRuntime, getOperationState } from './configure';
import { registerInternalModelHandle } from '../core/internalHandles';
import { registerModelMaintenance } from './maintenanceRegistry';
import type { MaintenanceReport, ModelCore, ModelRuntimeRegistrationOptions, ModelSchemaRegistrationOptions } from '../types';
import { resolveStaleTempRows, trimRowsPerScope } from '../utils/modelMaintenance';

export const registerModelSchema = <TStored extends { id: string } & Record<string, unknown>>(options: ModelSchemaRegistrationOptions<TStored>): void => {
  registerSchemaDeclaration({
    id: options.modelId,
    name: options.modelName,
    fields: Object.fromEntries(Object.entries(options.fields).map(([name, field]) => [name, { kind: field.kind, mode: field.mode, hasDefault: field.hasDefault }])),
    scopes: Object.fromEntries(
      Object.entries(options.scopes ?? {}).map(([name, spec]) => {
        const by = spec.by ? Object.fromEntries(Object.entries(spec.by).map(([scopeField, rowField]) => [scopeField, String(rowField)])) : null;
        const sort = spec.member
          ? 'member'
          : !spec.sort || spec.sort === 'server-order'
            ? 'server-order'
            : isMultiFieldSort(spec.sort)
              ? spec.sort.map(order => `field:${String(order.field)}:${order.dir}`).join('+')
              : 'field' in spec.sort
                ? `field:${String(spec.sort.field)}:${spec.sort.dir}`
                : 'comparator';
        return [name, { by, sort }];
      })
    )
  });
};

export const registerModelRuntime = <TStored extends { id: string; updatedAt?: string | null } & Record<string, unknown>, TInput>(
  options: ModelRuntimeRegistrationOptions<TStored, TInput>
): void => {
  const { planes, resolvedRelations } = options.context;
  const model = options.context.model<ModelCore<TStored, TInput>>();
  registerInternalModelHandle(model, {
    modelId: options.modelId,
    normalizeRowId: row => options.normalize(row).id,
    admitRowId: row => options.admitPlanRow(row)?.id,
    readRow: id => planes().entityState.read(id),
    applyRows: rows => options.applySnapshot(options.planRows(rows)),
    applyPatch: (id, patch, operationId) => getApplyRuntime().commit(createCommitEnvelope([{ kind: 'patch', model: options.modelId, id: String(id), patch, operationId }])),
    planRows: options.planRows,
    planReplace: options.planReplace,
    captureMembership: options.captureMembership,
    planRestore: options.planRestore,
    relations: resolvedRelations
  });
  if (options.maintenance) {
    const pendingTempRows = (): MaintenanceReport[] => {
      const maxAgeMs = options.maintenance?.dropTempRowsAfterMs;
      if (maxAgeMs === undefined) return [];
      const protectedIds = new Set([
        ...getOperationState().open().filter(operation => operation.model === options.modelId).flatMap(operation => operation.tempIds),
        ...modelProtectedTempIds()
      ]);
      const ids: string[] = [];
      resolveStaleTempRows(model, { maxAgeMs, protectedIds, onStale: row => ids.push(row.id) });
      if (ids.length === 0) return [];
      getApplyRuntime().commit(createCommitEnvelope([{ kind: 'destroy', model: options.modelId, ids, tombstone: false }]));
      noteDataLoss('stale-temp-row-expiry', options.modelId, ids.length);
      return [{ model: options.modelId, task: 'dropTempRows', affected: ids.length }];
    };
    const modelProtectedTempIds = (): ReadonlySet<string> => new Set(options.maintenance?.protectTempRows?.() ?? []);
    registerModelMaintenance(options.modelId, {
      boot: () => {
        const reports: MaintenanceReport[] = [];
        for (const task of options.maintenance?.maxRowsPerScope ?? []) {
          reports.push({ model: options.modelId, task: 'maxRowsPerScope', affected: trimRowsPerScope(model, task.scopeField, task.limit, task.compare, task.protect?.()) });
        }
        return [...reports, ...pendingTempRows()];
      },
      pendingTempRows,
      protectedTempIds: modelProtectedTempIds
    });
  }
  registerKeyedReset(`model:${options.modelId}`, () => {
    options.context.reset();
    // The apply target stays registered: a model must keep working after the kill-switch.
  });
};
