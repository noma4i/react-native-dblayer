import type { CollectionModel, ModelInstance, ModelRelation } from '../types';

type StoredRow = { id: string; updatedAt?: string | null };
type ModelFor<TStored extends StoredRow> = CollectionModel<unknown, TStored>;

const normalizeFilter = <TStored extends StoredRow>(filter?: Partial<TStored>): Partial<TStored> => {
  if (!filter) return {};
  const entries = Object.entries(filter).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as Partial<TStored>;
};

const isEmptyFilter = <TStored extends StoredRow>(filter: Partial<TStored>): boolean => Object.keys(normalizeFilter(filter)).length === 0;

const readAll = <TStored extends StoredRow>(model: ModelFor<TStored>, filter: Partial<TStored>): TStored[] => {
  const normalized = normalizeFilter(filter);
  return isEmptyFilter(normalized) ? model.getAll() : model.getWhere(normalized);
};

const useAll = <TStored extends StoredRow>(model: ModelFor<TStored>, filter: Partial<TStored>): TStored[] => {
  const normalized = normalizeFilter(filter);
  return isEmptyFilter(normalized) ? model.all() : model.where(normalized);
};

class ModelRelationImpl<TStored extends StoredRow> implements ModelRelation<TStored> {
  readonly #model: ModelFor<TStored>;
  readonly #filter: Partial<TStored>;

  constructor(model: ModelFor<TStored>, filter?: Partial<TStored>) {
    this.#model = model;
    this.#filter = normalizeFilter(filter);
  }

  where(filter: Partial<TStored>): ModelRelation<TStored> {
    return new ModelRelationImpl(this.#model, {
      ...this.#filter,
      ...normalizeFilter(filter)
    });
  }

  getAll(): TStored[] {
    return readAll(this.#model, this.#filter);
  }

  getFirst(): TStored | undefined {
    const normalized = normalizeFilter(this.#filter);
    return isEmptyFilter(normalized) ? this.#model.getFirstWhere({}) : this.#model.getFirstWhere(normalized);
  }

  getCount(): number {
    return this.getAll().length;
  }

  getIds(): string[] {
    return this.getAll().map(row => row.id);
  }

  all(): TStored[] {
    return useAll(this.#model, this.#filter);
  }

  first(): TStored | undefined {
    return this.all()[0];
  }

  count(): number {
    const normalized = normalizeFilter(this.#filter);
    return isEmptyFilter(normalized) ? this.#model.count() : this.#model.count(normalized);
  }

  ids(): string[] {
    return this.all().map(row => row.id);
  }

  update(patch: Partial<TStored>): number {
    const rows = this.getAll();
    let updated = 0;
    for (const row of rows) {
      if (this.#model.patch(row.id, patch)) {
        updated += 1;
      }
    }
    return updated;
  }

  delete(): number {
    const normalized = normalizeFilter(this.#filter);
    if (!isEmptyFilter(normalized)) {
      return this.#model.destroyWhere(normalized);
    }
    return this.#model.destroyMany(this.#model.getAll().map(row => row.id));
  }
}

const createInstance = <TStored extends StoredRow>(model: ModelFor<TStored>, row: TStored | undefined): ModelInstance<TStored> | undefined => {
  if (!row) return undefined;
  const id = row.id;
  return {
    ...row,
    update: (patch: Partial<TStored>) => model.patch(id, patch),
    delete: () => model.destroy(id)
  };
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
export const query = <TInput, TStored extends StoredRow>(model: CollectionModel<TInput, TStored>, filter?: Partial<TStored>): ModelRelation<TStored> =>
  new ModelRelationImpl(model as ModelFor<TStored>, filter);

/**
 * Read a snapshot row handle with fields plus update/delete methods.
 * @param model Collection model to read from.
 * @param id Row id; null or undefined returns undefined.
 * @returns Snapshot model instance, or undefined when absent.
 */
export const instance = <TInput, TStored extends StoredRow>(model: CollectionModel<TInput, TStored>, id: string | undefined | null): ModelInstance<TStored> | undefined =>
  createInstance(model as ModelFor<TStored>, model.get(id));

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
export const useInstance = <TInput, TStored extends StoredRow>(model: CollectionModel<TInput, TStored>, id: string | undefined | null): ModelInstance<TStored> | undefined =>
  createInstance(model as ModelFor<TStored>, model.find(id));
