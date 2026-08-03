import type {
  CompiledWritePlan,
  InvalidationTarget,
  RuntimeWriteTarget,
  WriteIntent,
  WriteOp,
  WritePlan,
  WritePlanCollectorOptions
} from '../types';
import { getInternalModelHandle } from '../core/internalHandles';
import { isNonArrayRecord, isNonEmptyString, isRecord } from '../utils/normalizeHelpers';

export const stampCausalRevision = (ops: readonly WriteOp[], baseRevision: number): WriteOp[] =>
  ops.map(op =>
    op.kind === 'upsert' || op.kind === 'patch' || op.kind === 'destroy'
      ? { ...op, baseRevision }
      : op
  );

export const runWritePlanInvalidations = (
  targets: readonly InvalidationTarget[],
  isCurrent: () => boolean,
  onError: (error: unknown) => void
): boolean => {
  if (!isCurrent()) return false;
  for (const target of targets) {
    if (!isCurrent()) return false;
    try {
      target.invalidate();
    } catch (error) {
      onError(error);
    }
    if (!isCurrent()) return false;
  }
  return isCurrent();
};

const isModelTarget = (value: unknown): value is RuntimeWriteTarget =>
  isRecord(value) && typeof Reflect.get(value, 'build') === 'function';

const requireModelTarget = (
  value: unknown,
  handles: WeakMap<object, ReturnType<typeof getInternalModelHandle>>
): { model: RuntimeWriteTarget; handle: ReturnType<typeof getInternalModelHandle> } => {
  if (!isModelTarget(value)) throw new Error('WritePlan requires a valid model target');
  const cached = handles.get(value);
  if (cached) return { model: value, handle: cached };
  const handle = getInternalModelHandle(value);
  handles.set(value, handle);
  return { model: value, handle };
};

const rejectOwnerTarget = (): never => {
  throw new Error('WritePlan cannot target its owner model');
};

const requireForeignModelTarget = (
  value: unknown,
  handles: WeakMap<object, ReturnType<typeof getInternalModelHandle>>,
  ownerKey: string | undefined
): { model: RuntimeWriteTarget; handle: ReturnType<typeof getInternalModelHandle> } => {
  if (ownerKey !== undefined && isRecord(value) && Reflect.get(value, 'key') === ownerKey) {
    rejectOwnerTarget();
  }
  return requireModelTarget(value, handles);
};

const requireInvalidationTarget = (value: unknown): InvalidationTarget => {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || typeof (value as { invalidate?: unknown }).invalidate !== 'function') {
    throw new Error('WritePlan requires an invalidation target');
  }
  return value as InvalidationTarget;
};

const requireUpdateIntent = (
  intent: Extract<WriteIntent, { kind: 'update' }>,
  handles: WeakMap<object, ReturnType<typeof getInternalModelHandle>>
): { model: RuntimeWriteTarget; handle: ReturnType<typeof getInternalModelHandle>; id: string; patch: Record<string, unknown> } => {
  const { model, handle } = requireModelTarget(intent.model, handles);
  if (!isNonEmptyString(intent.id)) throw new Error('WritePlan.update requires a non-empty string id');
  if (!isNonArrayRecord(intent.patch)) throw new Error('WritePlan.update requires a plain object patch');
  for (const [field, value] of Object.entries(intent.patch)) {
    if (value === undefined) throw new Error(`WritePlan.update does not accept undefined for "${field}"`);
  }
  return { model, handle, id: intent.id, patch: intent.patch };
};

const requireDestroyIntent = (
  intent: Extract<WriteIntent, { kind: 'destroy' }>,
  handles: WeakMap<object, ReturnType<typeof getInternalModelHandle>>
): { model: RuntimeWriteTarget; handle: ReturnType<typeof getInternalModelHandle>; ids: string[] } => {
  const { model, handle } = requireModelTarget(intent.model, handles);
  const ids = intent.ids.map(id => {
    if (!isNonEmptyString(id)) throw new Error('WritePlan.destroy requires non-empty string ids');
    return id;
  });
  return { model, handle, ids };
};

export const createWritePlanCollector = <TOwnerKey extends string = never>(
  options?: WritePlanCollectorOptions<TOwnerKey>
): { plan: WritePlan<TOwnerKey>; compile(): CompiledWritePlan } => {
  const intents: WriteIntent[] = [];
  const plan: WritePlan<TOwnerKey> = {
    upsert: (model, rowOrRows) => {
      intents.push({ kind: 'upsert', model, rows: Array.isArray(rowOrRows) ? [...rowOrRows] : [rowOrRows] });
    },
    update: (model, id, patch) => {
      intents.push({ kind: 'update', model, id, patch });
    },
    destroy: (model, idOrIds) => {
      intents.push({ kind: 'destroy', model, ids: Array.isArray(idOrIds) ? [...idOrIds] : [idOrIds] });
    },
    invalidate: target => {
      intents.push({ kind: 'invalidate', target });
    }
  };

  const compile = (): CompiledWritePlan => {
    const handles = new WeakMap<object, ReturnType<typeof getInternalModelHandle>>();
    for (const intent of intents) {
      if (intent.kind === 'upsert') {
        requireForeignModelTarget(intent.model, handles, options?.ownerKey);
        continue;
      }
      if (intent.kind === 'update') {
        const { model, handle } = requireUpdateIntent(intent, handles);
        requireForeignModelTarget(model, handles, options?.ownerKey);
        void handle;
        continue;
      }
      if (intent.kind === 'destroy') {
        const { model, handle } = requireDestroyIntent(intent, handles);
        requireForeignModelTarget(model, handles, options?.ownerKey);
        void handle;
        continue;
      }
      requireInvalidationTarget(intent.target);
    }

    const writeOps: WriteOp[] = [];
    const invalidations: InvalidationTarget[] = [];
    const invalidationTargets = new Set<InvalidationTarget>();
    for (const intent of intents) {
      if (intent.kind === 'upsert') {
        const { model, handle } = requireForeignModelTarget(intent.model, handles, options?.ownerKey);
        const rows = intent.rows.map(row => model.build(row));
        const planOptions = options?.origin === 'event' ? { origin: options.origin } : undefined;
        writeOps.push(...handle.planRows(rows, planOptions));
        continue;
      }
      if (intent.kind === 'update') {
        const { model, handle, id, patch } = requireUpdateIntent(intent, handles);
        requireForeignModelTarget(model, handles, options?.ownerKey);
        writeOps.push({ kind: 'patch', model: handle.modelId, id, patch });
        continue;
      }
      if (intent.kind === 'destroy') {
        const { model, handle, ids } = requireDestroyIntent(intent, handles);
        requireForeignModelTarget(model, handles, options?.ownerKey);
        writeOps.push({ kind: 'destroy', model: handle.modelId, ids });
        continue;
      }
      const target = requireInvalidationTarget(intent.target);
      if (invalidationTargets.has(target)) continue;
      invalidationTargets.add(target);
      invalidations.push(target);
    }
    return { writeOps, invalidations };
  };

  return { plan, compile };
};
