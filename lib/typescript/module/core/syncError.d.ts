import type { DbDefaults } from '../types';
/** Report one contained pipeline failure without allowing either the observer or logger to alter control flow. */
export declare const reportSyncError: (error: unknown, context: Parameters<NonNullable<DbDefaults["onSyncError"]>>[1], owner: string) => Error;
//# sourceMappingURL=syncError.d.ts.map