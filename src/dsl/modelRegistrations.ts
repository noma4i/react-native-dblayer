import { createCommitEnvelope } from '../core/apply/commitEnvelope';
import { isMultiFieldSort } from '../core/ordering';
import { registerGcHost } from '../core/gc';
import { noteDataLoss } from '../core/diagnostics';
import { registerKeyedReset } from '../core/reset';
import { registerSchemaDeclaration } from '../core/schemaManifest';
import { getApplyRuntime, getOperationState } from './configure';
import { clearFailedOptimisticMutation } from './mutationRuntime';
import { registerIngestModel } from './defineIngest';
import { registerInternalModelHandle } from '../core/internalHandles';
import { registerModelMaintenance } from './maintenanceRegistry';
import type { MaintenanceReport , ModelCore, ModelRuntimeRegistrationOptions, ModelSchemaRegistrationOptions } from '../types';
import { resolveStaleTempRows, trimRowsPerScope } from '../utils/modelMaintenance';

export const registerModelSchemaAndGc = <TStored extends { id: string } & Record<string, unknown>>(options: ModelSchemaRegistrationOptions<TStored>): void => {
  const { planes, resolvedRelations } = options.context;
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
  registerGcHost(options.modelId, {
    modelId: options.modelId,
    exempt: options.gc === 'exempt',
    rowIds: () =>
      planes()
        .entityState.values()
        .map(row => String(row.id)),
    hasRow: id => planes().entityState.read(id) !== undefined,
    scopeKeys: () => planes().scopeIndex.keys(),
    scopeEntryIds: key =>
      planes()
        .scopeIndex.read(key)
        .entries.map(entry => entry.id),
    detachScopeEntries: (key, ids) => {
      planes().scopeIndex.detach(key, ids);
    },
    scopeEntryCount: key => planes().scopeIndex.read(key).entries.length,
    removeScope: key => {
      planes().scopeIndex.remove(key);
    },
    idleScopeAfterMs: () => options.dropIdleScopesAfterMs,
    scopeLastAccess: key => planes().scopeIndex.lastAccess(key),
    evict: id => planes().entityState.evict(id),
    referencesOf: id => {
      const row = planes().entityState.read(id)!;
      const out: Array<{ model: string; id: string }> = [];
      for (const relation of Object.values(resolvedRelations())) {
        if (relation.kind === 'belongsTo') {
          const value = row[relation.foreignKey];
          if (typeof value === 'string' && value.length > 0) out.push({ model: relation.model.modelId, id: value });
        }
        if (relation.kind === 'references') {
          const raw = relation.ids(row);
          const list = Array.isArray(raw) ? raw : [raw];
          for (const value of list) {
            if (typeof value === 'string' && value.length > 0) out.push({ model: relation.model.modelId, id: value });
          }
        }
      }
      return out;
    }
  });
};

export const registerModelRuntime = <TStored extends { id: string; updatedAt?: string | null } & Record<string, unknown>, TInput>(
  options: ModelRuntimeRegistrationOptions<TStored, TInput>
): void => {
  const { planes, resolvedRelations } = options.context;
  const model = options.context.model<ModelCore<TStored, TInput>>();
  registerInternalModelHandle(model, {
    readRow: id => planes().entityState.read(id),
    applyRows: rows => options.applySnapshot(options.planRows(rows)),
    applyPatch: (id, patch, operationId) => getApplyRuntime().commit(createCommitEnvelope([{ kind: 'patch', model: options.modelId, id: String(id), patch, operationId }])),
    planRows: options.planRows,
    planReplace: options.planReplace,
    captureMembership: options.captureMembership,
    planRestore: options.planRestore,
    relations: resolvedRelations,
    revision: options.context.revision,
    dropTempRowsAfterMs: () => options.maintenance?.dropTempRowsAfterMs
  });
  registerIngestModel(options.modelName, model);
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
      for (const id of ids) clearFailedOptimisticMutation(options.modelId, id);
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
