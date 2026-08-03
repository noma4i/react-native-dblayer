import { useEffect } from 'react';
import { acquireModelSubscriptions } from '../core/modelEventRegistry';

/**
 * Activate every registered model event while the owning application surface is active.
 *
 * @param active Whether the owning application surface currently receives live events.
 */
export function useDbSubscriptions(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    const release = acquireModelSubscriptions();
    return () => release();
  }, [active]);
}
