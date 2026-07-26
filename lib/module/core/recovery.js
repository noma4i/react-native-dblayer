"use strict";

import { noteCorruptionModelReset } from "./diagnostics.js";
import { getDbLogger } from "./logger.js";
export class CorruptionError extends Error {
  constructor(keyClass, storageKey) {
    super(`corrupt persisted ${keyClass} key: ${storageKey}`);
    this.keyClass = keyClass;
    this.storageKey = storageKey;
  }
}

/** Cold-model degradation: wipes every persisted snapshot key of the model (rows, tombstones, scopes, applied marker). WAL records are intentionally kept - replay re-applies un-checkpointed mutations over the clean slate. */
export const coldResetModel = (storage, prefix, modelId) => {
  const keys = [...storage.keys(`${prefix}row:${modelId}:`), ...storage.keys(`${prefix}scope:${modelId}:`), `${prefix}tombstones:${modelId}`, `${prefix}applied:${modelId}`];
  storage.set([...new Set(keys)].map(key => ({
    key,
    value: null
  })));
  noteCorruptionModelReset();
  getDbLogger().error('cold-model recovery', {
    modelId
  });
};
//# sourceMappingURL=recovery.js.map