"use strict";

/** Create a plain immutable read builder whose terminals delegate to the model read engine. */
export const createReadBuilder = (where, terminals, orders = [], count = undefined, required = []) => ({
  orderBy: (field, direction = 'asc') => createReadBuilder(where, terminals, [...orders, {
    field,
    direction
  }], count, required),
  limit: nextCount => createReadBuilder(where, terminals, orders, nextCount, required),
  require: (...fields) => createReadBuilder(where, terminals, orders, count, [...required, ...fields]),
  rows: () => terminals.rows(where, orders, count, required),
  read: () => terminals.read(where, orders, count, required)
});
//# sourceMappingURL=readBuilder.js.map