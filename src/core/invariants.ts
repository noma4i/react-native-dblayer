/** Date.getTime() comparison - handles timezone offsets (Rails +11:00 vs client Z) */
const compareTimestamps = (a: string, b: string): number => new Date(a).getTime() - new Date(b).getTime();

/** Return true when an incoming timestamp is newer or equal to the existing timestamp. */
export const isIncomingNewer = (existingUpdatedAt: string | null | undefined, incomingUpdatedAt: string | null | undefined): boolean => {
  if (!incomingUpdatedAt && !existingUpdatedAt) return true;
  if (!incomingUpdatedAt) return false;
  if (!existingUpdatedAt) return true;
  return compareTimestamps(incomingUpdatedAt, existingUpdatedAt) >= 0;
};
