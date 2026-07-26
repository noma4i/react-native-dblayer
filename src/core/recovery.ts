import { noteCorruptionModelReset } from './diagnostics';
import { getDbLogger } from './logger';
import type { StoragePlane } from './planes/storagePlane';

export class CorruptionError extends Error {
  constructor(
    readonly keyClass: 'row' | 'tombstones' | 'scope',
    readonly storageKey: string
  ) {
    super(`corrupt persisted ${keyClass} key: ${storageKey}`);
  }
}

/** Cold-model degradation: wipes every persisted snapshot key of the model (rows, tombstones, scopes, applied marker). WAL records are intentionally kept - replay re-applies un-checkpointed mutations over the clean slate. */
export const coldResetModel = (storage: StoragePlane, prefix: string, modelId: string): void => {
  const keys = [
    ...storage.keys(`${prefix}row:${modelId}:`),
    ...storage.keys(`${prefix}scope:${modelId}:`),
    `${prefix}tombstones:${modelId}`,
    `${prefix}applied:${modelId}`
  ];
  storage.set([...new Set(keys)].map(key => ({ key, value: null })));
  noteCorruptionModelReset();
  getDbLogger().error('cold-model recovery', { modelId });
};
