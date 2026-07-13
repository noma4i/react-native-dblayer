import type { SyncContract } from '../types';

/** Build a merge sync contract for server data writes. */
export const mergeSyncContract = <TScope = undefined>(source: string, scope?: TScope, snapshotSeq?: number): SyncContract<TScope> => ({
  mode: 'merge',
  source,
  scope,
  ...(snapshotSeq === undefined ? {} : { snapshotSeq })
});

/** Build a replace sync contract for server data writes. */
export const replaceSyncContract = <TScope = undefined>(source: string, scope?: TScope, snapshotSeq?: number): SyncContract<TScope> => ({
  mode: 'replace',
  source,
  scope,
  ...(snapshotSeq === undefined ? {} : { snapshotSeq })
});
