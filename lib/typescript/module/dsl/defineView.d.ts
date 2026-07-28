import type { ModelCore, RowRecord, ViewConfig, ViewHandle } from '../types';
/**
 * Compose a model scope with declared relations or computed target ids into one pinpoint-reactive view.
 *
 * @param model Source model that owns the named scope and declared relation includes.
 * @param name Stable view name used in validation errors.
 * @param config Source scope, include declarations, projection, and optional render identity keys.
 * @returns A hook handle with full-scope and local-window reads.
 */
export declare const defineView: <TRow extends RowRecord, TIncluded extends Record<string, unknown>, TItem, TScope>(model: ModelCore<TRow>, name: string, publicConfig: ViewConfig<TRow, TIncluded, TItem>) => ViewHandle<TItem, TScope>;
//# sourceMappingURL=defineView.d.ts.map