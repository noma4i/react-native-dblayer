import type { SyncContract } from '../types';

/** Build a merge sync contract for server data writes. */
export const mergeSyncContract = <TScope = undefined>(source: string, scope?: TScope): SyncContract<TScope> => ({
  mode: 'merge',
  source,
  scope
});

/** Build a replace sync contract for server data writes. */
export const replaceSyncContract = <TScope = undefined>(source: string, scope?: TScope): SyncContract<TScope> => ({
  mode: 'replace',
  source,
  scope
});
