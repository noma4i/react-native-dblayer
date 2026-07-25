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
 * A successful boot renders `children`. A rejected boot throws the rejection reason during
 * render (on the next render after the rejection is observed), so it surfaces as an ordinary
 * React render error instead of leaving consumers stuck behind a permanent `null` - `bootDb` is
 * intentionally fail-loud (see its JSDoc in `lifecycle.ts`), and this provider must not swallow
 * that by only handling the resolved case.
 *
 * @param props Children plus optional boot-only lifecycle options.
 * @returns The internal query provider with children after a successful boot; throws in render if boot rejected.
 */
export declare const DbProvider: ({ children, bootOptions }: DbProviderProps) => React.JSX.Element;
//# sourceMappingURL=DbProvider.d.ts.map