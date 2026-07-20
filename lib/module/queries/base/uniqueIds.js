"use strict";

import { uniq } from 'es-toolkit';

/** Shared immutable empty id list for stable fallback reads. */
export const emptyIds = [];

/**
 * Return unique non-empty ids in first-seen order.
 *
 * @param ids Candidate ids that may be nullish or duplicated.
 * @returns A new array containing each truthy id once.
 */
export const dedupeIds = ids => uniq(ids.filter(id => Boolean(id)));
//# sourceMappingURL=uniqueIds.js.map