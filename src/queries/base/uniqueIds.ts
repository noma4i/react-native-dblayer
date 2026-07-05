export const EMPTY_IDS: string[] = [];

export const createUniqueIds = (ids: Array<string | null | undefined>): string[] => {
  const seen = new Set<string>();
  const uniqueIds: string[] = [];

  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniqueIds.push(id);
  }

  return uniqueIds;
};
