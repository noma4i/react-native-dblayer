'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});
exports.waitForRow = exports.patchWhenRowExists = void 0;
var _configure = require('../dsl/configure.js');
const rowDepOf = (model, id) => ({
  kind: 'row',
  model: model.modelId,
  id
});
const resolvePatch = (row, patch) => (typeof patch === 'function' ? patch(row) : patch);

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
const patchWhenRowExists = (model, id, patch, options) => {
  const generation = (0, _configure.getRuntimeGeneration)();
  const existing = model.get(id);
  if (existing) {
    model.patch(id, resolvePatch(existing, patch));
    return;
  }
  let timer = null;
  let active = true;
  const subscription = (0, _configure.getCommitBus)().subscribe(() => {
    if (!active) return;
    if (generation !== (0, _configure.getRuntimeGeneration)()) return;
    const row = model.get(id);
    if (!row) return;
    active = false;
    if (timer) clearTimeout(timer);
    subscription.unsubscribe();
    model.patch(id, resolvePatch(row, patch));
  }, [rowDepOf(model, id)]);
  timer = setTimeout(() => {
    active = false;
    subscription.unsubscribe();
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
exports.patchWhenRowExists = patchWhenRowExists;
const waitForRow = (model, id, options) => {
  const generation = (0, _configure.getRuntimeGeneration)();
  const existing = model.get(id);
  if (existing) return Promise.resolve(existing);
  return new Promise(resolve => {
    let done = false;
    let timer = null;
    const finish = value => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      subscription.unsubscribe();
      resolve(value);
    };
    const onAbort = () => finish(undefined);
    const subscription = (0, _configure.getCommitBus)().subscribe(() => {
      if (generation !== (0, _configure.getRuntimeGeneration)()) {
        finish(undefined);
        return;
      }
      const row = model.get(id);
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
