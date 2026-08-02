"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.runWritePlanInvalidations = exports.createWritePlanCollector = void 0;
var _internalHandles = require("../core/internalHandles.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
const runWritePlanInvalidations = (targets, isCurrent, onError) => {
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
exports.runWritePlanInvalidations = runWritePlanInvalidations;
const isModelTarget = value => (0, _normalizeHelpers.isRecord)(value) && typeof Reflect.get(value, 'build') === 'function';
const requireModelTarget = (value, handles) => {
  if (!isModelTarget(value)) throw new Error('WritePlan requires a valid model target');
  const cached = handles.get(value);
  if (cached) return {
    model: value,
    handle: cached
  };
  const handle = (0, _internalHandles.getInternalModelHandle)(value);
  handles.set(value, handle);
  return {
    model: value,
    handle
  };
};
const requireInvalidationTarget = value => {
  if (typeof value !== 'object' && typeof value !== 'function' || value === null || typeof value.invalidate !== 'function') {
    throw new Error('WritePlan requires an invalidation target');
  }
  return value;
};
const requireUpdateIntent = (intent, handles) => {
  const {
    model,
    handle
  } = requireModelTarget(intent.model, handles);
  if (!(0, _normalizeHelpers.isNonEmptyString)(intent.id)) throw new Error('WritePlan.update requires a non-empty string id');
  if (!(0, _normalizeHelpers.isNonArrayRecord)(intent.patch)) throw new Error('WritePlan.update requires a plain object patch');
  for (const [field, value] of Object.entries(intent.patch)) {
    if (value === undefined) throw new Error(`WritePlan.update does not accept undefined for "${field}"`);
  }
  return {
    model,
    handle,
    id: intent.id,
    patch: intent.patch
  };
};
const requireDestroyIntent = (intent, handles) => {
  const {
    model,
    handle
  } = requireModelTarget(intent.model, handles);
  const ids = intent.ids.map(id => {
    if (!(0, _normalizeHelpers.isNonEmptyString)(id)) throw new Error('WritePlan.destroy requires non-empty string ids');
    return id;
  });
  return {
    model,
    handle,
    ids
  };
};
const createWritePlanCollector = options => {
  const intents = [];
  const plan = {
    upsert: (model, rowOrRows) => {
      intents.push({
        kind: 'upsert',
        model,
        rows: Array.isArray(rowOrRows) ? [...rowOrRows] : [rowOrRows]
      });
    },
    update: (model, id, patch) => {
      intents.push({
        kind: 'update',
        model,
        id,
        patch
      });
    },
    destroy: (model, idOrIds) => {
      intents.push({
        kind: 'destroy',
        model,
        ids: Array.isArray(idOrIds) ? [...idOrIds] : [idOrIds]
      });
    },
    invalidate: target => {
      intents.push({
        kind: 'invalidate',
        target
      });
    }
  };
  const compile = () => {
    const handles = new WeakMap();
    for (const intent of intents) {
      if (intent.kind === 'upsert') {
        requireModelTarget(intent.model, handles);
        continue;
      }
      if (intent.kind === 'update') {
        requireUpdateIntent(intent, handles);
        continue;
      }
      if (intent.kind === 'destroy') {
        requireDestroyIntent(intent, handles);
        continue;
      }
      requireInvalidationTarget(intent.target);
    }
    const writeOps = [];
    const invalidations = [];
    const invalidationTargets = new Set();
    for (const intent of intents) {
      if (intent.kind === 'upsert') {
        const {
          model,
          handle
        } = requireModelTarget(intent.model, handles);
        const rows = intent.rows.map(row => model.build(row));
        const planOptions = options?.origin === 'event' ? {
          origin: options.origin
        } : undefined;
        writeOps.push(...handle.planRows(rows, planOptions));
        continue;
      }
      if (intent.kind === 'update') {
        const {
          handle,
          id,
          patch
        } = requireUpdateIntent(intent, handles);
        writeOps.push({
          kind: 'patch',
          model: handle.modelId,
          id,
          patch
        });
        continue;
      }
      if (intent.kind === 'destroy') {
        const {
          handle,
          ids
        } = requireDestroyIntent(intent, handles);
        writeOps.push({
          kind: 'destroy',
          model: handle.modelId,
          ids
        });
        continue;
      }
      const target = requireInvalidationTarget(intent.target);
      if (invalidationTargets.has(target)) continue;
      invalidationTargets.add(target);
      invalidations.push(target);
    }
    return {
      writeOps,
      invalidations
    };
  };
  return {
    plan,
    compile
  };
};
exports.createWritePlanCollector = createWritePlanCollector;
//# sourceMappingURL=writePlan.js.map