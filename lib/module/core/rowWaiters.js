"use strict";

import { getCommitBus } from "../dsl/configure.js";
const rowDepOf = (model, id) => ({
  kind: 'row',
  model: model.modelId,
  id
});
const resolvePatch = (row, patch) => typeof patch === 'function' ? patch(row) : patch;

/**
 * Apply the patch now when the row exists, otherwise defer it on the commit bus until the row
 * appears or the TTL expires. Deferred patches for one row apply in registration order because
 * bus subscribers are notified in subscription order.
 */
export const patchWhenPresent = (model, id, patch, options) => {
  const existing = model.get(id);
  if (existing) {
    model.patch(id, resolvePatch(existing, patch));
    return;
  }
  let timer = null;
  const subscription = getCommitBus().subscribe(() => {
    const row = model.get(id);
    if (!row) return;
    if (timer) clearTimeout(timer);
    subscription.unsubscribe();
    model.patch(id, resolvePatch(row, patch));
  }, [rowDepOf(model, id)]);
  timer = setTimeout(() => subscription.unsubscribe(), options.ttlMs);
};

/** Resolve with the row once it exists, or with `undefined` on timeout/abort. */
export const waitForRow = (model, id, options) => {
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
    const subscription = getCommitBus().subscribe(() => {
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
//# sourceMappingURL=rowWaiters.js.map