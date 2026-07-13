import type { SyncContract } from '../types';

/** Build a merge sync contract for server data writes. */
export const mergeSyncContract = <TScope = undefined>(source: string, scope?: TScope, protectAfterSeq?: number): SyncContract<TScope> => ({
  mode: 'merge',
  source,
  scope,
  ...(protectAfterSeq === undefined ? {} : { protectAfterSeq })
});

/** Build a replace sync contract for server data writes. */
export const replaceSyncContract = <TScope = undefined>(source: string, scope?: TScope, protectAfterSeq?: number): SyncContract<TScope> => ({
  mode: 'replace',
  source,
  scope,
  ...(protectAfterSeq === undefined ? {} : { protectAfterSeq })
});
