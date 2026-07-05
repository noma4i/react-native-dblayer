"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useInstance = exports.query = exports.instance = void 0;
const normalizeFilter = filter => {
  if (!filter) return {};
  const entries = Object.entries(filter).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries);
};
const isEmptyFilter = filter => Object.keys(normalizeFilter(filter)).length === 0;
const readAll = (model, filter) => {
  const normalized = normalizeFilter(filter);
  return isEmptyFilter(normalized) ? model.getAll() : model.getWhere(normalized);
};
const useAll = (model, filter) => {
  const normalized = normalizeFilter(filter);
  return isEmptyFilter(normalized) ? model.all() : model.where(normalized);
};
class ModelRelationImpl {
  #model;
  #filter;
  constructor(model, filter) {
    this.#model = model;
    this.#filter = normalizeFilter(filter);
  }
  where(filter) {
    return new ModelRelationImpl(this.#model, {
      ...this.#filter,
      ...normalizeFilter(filter)
    });
  }
  getAll() {
    return readAll(this.#model, this.#filter);
  }
  getFirst() {
    const normalized = normalizeFilter(this.#filter);
    return isEmptyFilter(normalized) ? this.#model.getFirstWhere({}) : this.#model.getFirstWhere(normalized);
  }
  getCount() {
    return this.getAll().length;
  }
  getIds() {
    return this.getAll().map(row => row.id);
  }
  all() {
    return useAll(this.#model, this.#filter);
  }
  first() {
    return this.all()[0];
  }
  count() {
    const normalized = normalizeFilter(this.#filter);
    return isEmptyFilter(normalized) ? this.#model.count() : this.#model.count(normalized);
  }
  ids() {
    return this.all().map(row => row.id);
  }
  update(patch) {
    const rows = this.getAll();
    let updated = 0;
    for (const row of rows) {
      if (this.#model.patch(row.id, patch)) {
        updated += 1;
      }
    }
    return updated;
  }
  delete() {
    const normalized = normalizeFilter(this.#filter);
    if (!isEmptyFilter(normalized)) {
      return this.#model.destroyWhere(normalized);
    }
    return this.#model.destroyMany(this.#model.getAll().map(row => row.id));
  }
}
const createInstance = (model, row) => {
  if (!row) return undefined;
  const id = row.id;
  return {
    ...row,
    update: patch => model.patch(id, patch),
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
const query = (model, filter) => new ModelRelationImpl(model, filter);

/**
 * Read a snapshot row handle with fields plus update/delete methods.
 * @param model Collection model to read from.
 * @param id Row id; null or undefined returns undefined.
 * @returns Snapshot model instance, or undefined when absent.
 */
exports.query = query;
const instance = (model, id) => createInstance(model, model.get(id));

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
exports.instance = instance;
const useInstance = (model, id) => createInstance(model, model.find(id));
exports.useInstance = useInstance;
//# sourceMappingURL=index.js.map