import { uniq } from 'es-toolkit';
import { noteCorruptionModelReset, noteDataLoss } from './diagnostics';
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
  const uniqueKeys = uniq(keys);
  storage.set(uniqueKeys.map(key => ({ key, value: null })));
  noteCorruptionModelReset();
  noteDataLoss('model-corruption-recovery', modelId, uniqueKeys.length);
  getDbLogger().error('cold-model recovery', { modelId });
};
