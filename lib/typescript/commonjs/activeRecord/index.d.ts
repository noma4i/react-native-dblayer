import type { CollectionModel, ModelInstance, ModelRelation } from '../types';
type StoredRow = {
    id: string;
    updatedAt?: string | null;
};
/**
 * Build an immutable chainable relation over a model.
 * @param model Collection model to query.
 * @param filter Optional initial shallow filter.
 * @returns Model relation with snapshot, hook, and bulk-write terminals.
 *
 * @example
 * const admins = query(UserModel).where({ role: 'admin' });
 * const adminIds = admins.getIds();
 */
export declare const query: <TInput, TStored extends StoredRow>(model: CollectionModel<TInput, TStored>, filter?: Partial<TStored>) => ModelRelation<TStored>;
/**
 * Read a snapshot row handle with fields plus update/delete methods.
 * @param model Collection model to read from.
 * @param id Row id; null or undefined returns undefined.
 * @returns Snapshot model instance, or undefined when absent.
 */
export declare const instance: <TInput, TStored extends StoredRow>(model: CollectionModel<TInput, TStored>, id: string | undefined | null) => ModelInstance<TStored> | undefined;
/**
 * React hook that reads one row as a live instance handle.
 * @param model Collection model to read from.
 * @param id Row id; null or undefined returns undefined.
 * @returns Reactive model instance, or undefined when absent.
 *
 * @example
 * const user = useInstance(UserModel, id);
 * user?.update({ role: 'admin' });
 */
export declare const useInstance: <TInput, TStored extends StoredRow>(model: CollectionModel<TInput, TStored>, id: string | undefined | null) => ModelInstance<TStored> | undefined;
export {};
//# sourceMappingURL=index.d.ts.map