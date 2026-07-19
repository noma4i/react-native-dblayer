import React from 'react';
import { type BootDbOptions } from './lifecycle';
export type DbProviderProps = {
    /** Application subtree that may read the database after boot completes. */
    children: React.ReactNode;
    /** Data lifecycle options forwarded to `bootDb` once on mount. */
    bootOptions?: BootDbOptions;
};
/**
 * Provide the library-owned query client and gate database consumers until boot completes.
 *
 * @param props Children plus optional boot-only lifecycle options.
 * @returns The internal query provider with children after a successful boot, otherwise no children.
 */
export declare const DbProvider: ({ children, bootOptions }: DbProviderProps) => React.JSX.Element;
//# sourceMappingURL=DbProvider.d.ts.map
