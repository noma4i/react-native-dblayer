import React from 'react';
import type { DbProviderProps } from '../types';
/**
 * Provide the boot gate and foreground-resume dispatcher for coordinator-owned reads.
 *
 * @param props Application subtree that becomes available after boot.
 * @returns Booted application subtree, or null while boot is pending.
 */
export declare const DbProvider: ({ children }: DbProviderProps) => React.ReactNode;
//# sourceMappingURL=DbProvider.d.ts.map