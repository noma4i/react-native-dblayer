"use strict";

import { getCommitBus } from "../dsl/configure.js";
import { createGenerationFence } from "../utils/runtimeGeneration.js";

/** Resolve a committed model row or finish with `undefined` at a terminal boundary. */
export const waitForCommittedRow = (model, id, options) => {
  if (id == null || options.signal?.aborted) return Promise.resolve(undefined);
  const generationFence = createGenerationFence();
  const existing = model.find(id);
  if (existing) return Promise.resolve(existing);
  return new Promise(resolve => {
    let timer = null;
    let subscription = null;
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      options.signal?.removeEventListener('abort', onAbort);
      subscription?.unsubscribe();
      subscription = null;
      resolve(value);
    };
    const onAbort = () => finish(undefined);
    subscription = getCommitBus().subscribe(() => {
      if (!generationFence.isCurrent()) {
        finish(undefined);
        return;
      }
      const row = model.find(id);
      if (row) finish(row);
    }, [{
      kind: 'row',
      model: model.key,
      id
    }]);
    timer = setTimeout(() => finish(undefined), options.timeoutMs);
    if (options.signal?.aborted) {
      finish(undefined);
      return;
    }
    options.signal?.addEventListener('abort', onAbort);
  });
};
//# sourceMappingURL=waitForCommittedRow.js.map