/** Date.getTime() comparison - handles timezone offsets (Rails +11:00 vs client Z) */
const compareTimestamps = (a: string, b: string): number => new Date(a).getTime() - new Date(b).getTime();

/**
 * Return true when an incoming `updatedAt` is newer than or equal to the existing one - the newer-wins
 * acceptance gate used to decide whether an incoming write should overwrite a stored row. Nullish
 * timestamps are permissive: both nullish accepts, only-existing-nullish accepts, only-incoming-nullish
 * rejects (an incoming row with no timestamp cannot prove it is newer).
 *
 * @param existingUpdatedAt The stored row's `updatedAt`, or nullish if absent/never set.
 * @param incomingUpdatedAt The incoming row's `updatedAt`, or nullish if absent.
 * @returns `true` when the incoming write should be accepted.
 */
export const isIncomingNewer = (existingUpdatedAt: string | null | undefined, incomingUpdatedAt: string | null | undefined): boolean => {
  if (!incomingUpdatedAt && !existingUpdatedAt) return true;
  if (!incomingUpdatedAt) return false;
  if (!existingUpdatedAt) return true;
  return compareTimestamps(incomingUpdatedAt, existingUpdatedAt) >= 0;
};
