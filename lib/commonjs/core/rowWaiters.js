"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.waitForRow = exports.updateWhenRowExists = void 0;
var _configure = require("../dsl/configure.js");
var _runtimeGeneration = require("../utils/runtimeGeneration.js");
var _diagnostics = require("./diagnostics.js");
const modelKeyOf = model => 'modelId' in model ? model.modelId : model.key;
const rowDepOf = (model, id) => ({
  kind: 'row',
  model: modelKeyOf(model),
  id
});
const resolvePatch = (row, patch) => typeof patch === 'function' ? patch(row) : patch;

/**
 * Apply the patch now when the row exists, otherwise defer it on the commit bus until the row
 * appears or the TTL expires. Deferred patches for one row apply in registration order because
 * bus subscribers are notified in subscription order.
 *
 * @param model Model to read and patch.
 * @param id Row id to patch now or wait for.
 * @param patch A partial update, or a function deriving one from the row once it is known.
 * @param options.ttlMs Maximum time to keep a deferred patch queued before dropping it.
 */
const updateWhenRowExists = (model, id, patch, options) => {
  const generationFence = (0, _runtimeGeneration.createGenerationFence)();
  const existing = model.find(id);
  if (existing) {
    model.update(id, resolvePatch(existing, patch));
    return;
  }
  let timer = null;
  /** Shared teardown for the terminal cases (applied, stale generation, TTL) - unsubscribes immediately instead of leaving a dead subscriber on the commit bus until the TTL timer sweeps it. */
  const stop = () => {
    if (timer) clearTimeout(timer);
    subscription.unsubscribe();
  };
  const subscription = (0, _configure.getCommitBus)().subscribe(() => {
    if (!generationFence.isCurrent()) {
      stop();
      return;
    }
    const row = model.find(id);
    if (!row) return;
    stop();
    model.update(id, resolvePatch(row, patch));
  }, [rowDepOf(model, id)]);
  timer = setTimeout(() => {
    (0, _diagnostics.noteDataLoss)('deferred-patch-timeout', modelKeyOf(model), 1);
    stop();
  }, options.ttlMs);
};

/**
 * Resolve with the row once it exists, or with `undefined` on timeout/abort. Resolves immediately, without
 * subscribing, when the row already exists.
 *
 * @param model Model to read.
 * @param id Row id to wait for.
 * @param options.timeoutMs Maximum time to wait before resolving with `undefined`.
 * @param options.signal Optional abort signal that resolves with `undefined` and cleans up immediately.
 * @returns A promise for the row, or `undefined` on timeout/abort.
 */
exports.updateWhenRowExists = updateWhenRowExists;
const waitForRow = (model, id, options) => {
  const generationFence = (0, _runtimeGeneration.createGenerationFence)();
  const existing = model.find(id);
  if (existing) return Promise.resolve(existing);
  return new Promise(resolve => {
    let timer = null;
    const finish = value => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      subscription.unsubscribe();
      resolve(value);
    };
    const onAbort = () => finish(undefined);
    const subscription = (0, _configure.getCommitBus)().subscribe(() => {
      if (!generationFence.isCurrent()) {
        finish(undefined);
        return;
      }
      const row = model.find(id);
      if (row) finish(row);
    }, [rowDepOf(model, id)]);
    timer = setTimeout(() => finish(undefined), options.timeoutMs);
    if (options.signal?.aborted) {
      finish(undefined);
      return;
    }
    options.signal?.addEventListener('abort', onAbort);
  });
};
exports.waitForRow = waitForRow;
//# sourceMappingURL=rowWaiters.js.map