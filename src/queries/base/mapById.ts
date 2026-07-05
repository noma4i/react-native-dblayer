import { useMemo } from 'react';

export const useMapById = <T extends { id: string }>(items: T[]): Map<string, T> => {
  return useMemo(() => {
    const map = new Map<string, T>();
    for (const item of items) {
      map.set(item.id, item);
    }
    return map;
  }, [items]);
};
