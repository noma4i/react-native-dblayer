"use strict";

import { useMemo } from 'react';
export const useMapById = items => {
  return useMemo(() => {
    const map = new Map();
    for (const item of items) {
      map.set(item.id, item);
    }
    return map;
  }, [items]);
};
//# sourceMappingURL=mapById.js.map