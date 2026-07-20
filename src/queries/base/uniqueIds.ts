import { uniq } from 'es-toolkit';

/** Shared immutable empty id list for stable fallback reads. */
export const emptyIds: string[] = [];

/**
 * Return unique non-empty ids in first-seen order.
 *
 * @param ids Candidate ids that may be nullish or duplicated.
 * @returns A new array containing each truthy id once.
 */
export const dedupeIds = (ids: Array<string | null | undefined>): string[] => uniq(ids.filter((id): id is string => Boolean(id)));
