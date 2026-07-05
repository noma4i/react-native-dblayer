import type { ServerSyncContract } from '../types';

/** Build a merge sync contract for server data writes. */
export const mergeSyncContract = <TScope = undefined>(source: string, scope?: TScope): ServerSyncContract<TScope> => ({
  mode: 'merge',
  source,
  scope
});

/** Build a replace sync contract for server data writes. */
export const replaceSyncContract = <TScope = undefined>(source: string, scope?: TScope): ServerSyncContract<TScope> => ({
  mode: 'replace',
  source,
  scope
});
