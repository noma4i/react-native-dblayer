import type { ModelRootOwner, ModelRootPlan, ModelRootUpdate, OperationIntent, WriteOp } from '../types';
import { isNonArrayRecord, isNonEmptyString } from '../utils/normalizeHelpers';

const rootForms = ['insert', 'update', 'destroy'] as const;

const rootFormOf = (root: unknown): (typeof rootForms)[number] => {
  if (!isNonArrayRecord(root)) throw new Error('ModelRootPlan must contain exactly one root form');
  const keys = Reflect.ownKeys(root);
  if (keys.length !== 1 || typeof keys[0] !== 'string' || !rootForms.includes(keys[0] as (typeof rootForms)[number])) {
    throw new Error('ModelRootPlan must contain exactly one root form');
  }
  return keys[0] as (typeof rootForms)[number];
};

export const modelRootIntentOf = (root: unknown): OperationIntent => {
  const form = rootFormOf(root);
  if (form === 'insert') return 'insert';
  if (form === 'update') return 'patch';
  return 'destroy';
};

const asArray = <T>(value: T | readonly T[]): readonly T[] => (Array.isArray(value) ? (value as readonly T[]) : [value as T]);

const normalizeRootId = (value: unknown, form: 'update' | 'destroy'): string => {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`ModelRootPlan ${form} requires a non-empty id`);
  }
  const id = String(value);
  if (!isNonEmptyString(id)) throw new Error(`ModelRootPlan ${form} requires a non-empty id`);
  return id;
};

export const compileModelRootPlan = <TContext, TInput, TStored extends { id: string }>(
  owner: ModelRootOwner<TInput>,
  root: ModelRootPlan<TContext, TInput, TStored>,
  context: TContext
): WriteOp[] => {
  const form = rootFormOf(root);
  if (form === 'insert' && 'insert' in root) {
    const insert = root.insert;
    if (!insert) throw new Error('ModelRootPlan must contain exactly one root form');
    const selected = insert.select(context);
    if (selected == null) return [];
    if (Array.isArray(selected) && selected.length === 0) return owner.planEmpty?.() ?? [];
    return owner.planRows(asArray(selected));
  }
  if (form === 'update' && 'update' in root) {
    const update = root.update;
    if (!update) throw new Error('ModelRootPlan must contain exactly one root form');
    const selected = update.select(context);
    if (selected == null || (Array.isArray(selected) && selected.length === 0)) return [];
    const updates: readonly ModelRootUpdate<TStored>[] = Array.isArray(selected)
      ? (selected as readonly ModelRootUpdate<TStored>[])
      : [selected as ModelRootUpdate<TStored>];
    const normalized = updates.map(update => {
      if (!isNonArrayRecord(update.patch)) throw new Error('ModelRootPlan update requires a plain object patch');
      if ('id' in update.patch) throw new Error('ModelRootPlan update patch cannot contain id');
      for (const [field, value] of Object.entries(update.patch)) {
        if (value === undefined) throw new Error(`ModelRootPlan update patch field "${field}" cannot be undefined`);
      }
      return { id: normalizeRootId(update.id, 'update'), patch: update.patch };
    });
    return normalized.map(update => ({ kind: 'patch', model: owner.modelId, id: update.id, patch: update.patch }));
  }
  if (!('destroy' in root)) throw new Error('ModelRootPlan must contain exactly one root form');
  const destroy = root.destroy;
  if (!destroy) throw new Error('ModelRootPlan must contain exactly one root form');
  const selected = destroy.select(context);
  if (selected == null || (Array.isArray(selected) && selected.length === 0)) return [];
  const ids: readonly string[] = Array.isArray(selected) ? (selected as readonly string[]) : [selected as string];
  return [{ kind: 'destroy', model: owner.modelId, ids: ids.map(id => normalizeRootId(id, 'destroy')) }];
};
