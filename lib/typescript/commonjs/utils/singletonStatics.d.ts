import type { RowId, SingletonModel, SingletonStatics } from '../types';
/**
 * Build statics for a single-row model with defaults and clamped numeric updates.
 *
 * @param model Model that owns the singleton row.
 * @param recordId Stable singleton row id.
 * @param defaults Default row returned before insertion and used for first upsert.
 * @returns Singleton statics for reading, upserting, and clamped numeric patches.
 */
export declare const createSingletonStatics: <TStored extends RowId>(model: SingletonModel<TStored>, recordId: string, defaults: TStored) => SingletonStatics<TStored>;
//# sourceMappingURL=singletonStatics.d.ts.map