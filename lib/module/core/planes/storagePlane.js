"use strict";

import { getDbStorageAdapter } from "../storage.js";

/** Atomic-enough synchronous storage seam used by all v6 state planes. */

export const mmkvStoragePlane = () => ({
  get: key => getDbStorageAdapter().getItem(key) ?? undefined,
  set: entries => {
    const storage = getDbStorageAdapter();
    for (const entry of entries) {
      if (entry.value === null) storage.removeItem(entry.key);else storage.setItem(entry.key, entry.value);
    }
  },
  keys: prefix => getDbStorageAdapter().getAllKeys().filter(key => key.startsWith(prefix))
});
//# sourceMappingURL=storagePlane.js.map