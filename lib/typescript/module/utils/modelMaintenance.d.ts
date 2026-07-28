import type { CreatedAtRow, DestroyManyModel, ResolveStaleTempRowsOptions, RowId, RowProtect } from '../types';
/**
 * Keep at most `maxPerScope` unprotected rows in each scope.
 *
 * The supplied comparator must order rows from newest/most important to oldest.
 *
 * @param model Model that can snapshot rows and delete rows for maintenance.
 * @param scopeField Row field used to group rows.
 * @param maxPerScope Maximum unprotected rows kept per scope.
 * @param compare Comparator applied inside each scope before trimming.
 * @param protect Optional protected row predicate or id list.
 * @returns Number of rows deleted.
 */
export declare const trimRowsPerScope: <TStored extends RowId, TScopeField extends Extract<keyof TStored, string>>(model: DestroyManyModel<TStored>, scopeField: TScopeField, maxPerScope: number, compare: (left: TStored, right: TStored) => number, protect?: RowProtect<TStored>) => number;
/**
 * Run `onStale` for temp-id rows older than the age threshold and not protected. A row whose
 * `createdAt` cannot be parsed (missing, malformed, or otherwise NaN) is treated as maximally old and
 * resolved immediately - an unparseable timestamp must not grant a stale row indefinite protection
 * from cleanup.
 *
 * @param model Snapshot model used to scan temp rows.
 * @param options Age threshold, optional protected ids, and stale-row callback.
 * @returns Number of stale temp rows resolved.
 */
export declare const resolveStaleTempRows: <TStored extends CreatedAtRow>(model: Pick<DestroyManyModel<TStored>, "all">, options: ResolveStaleTempRowsOptions<TStored>) => number;
//# sourceMappingURL=modelMaintenance.d.ts.map