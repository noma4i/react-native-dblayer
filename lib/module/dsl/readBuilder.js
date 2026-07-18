"use strict";

/** Create a plain immutable read builder whose terminals delegate to the model read engine. */
export const createReadBuilder = (where, terminals, orders = [], count = undefined) => ({
  orderBy: (field, direction = 'asc') => createReadBuilder(where, terminals, [...orders, {
    field,
    direction
  }], count),
  limit: nextCount => createReadBuilder(where, terminals, orders, nextCount),
  rows: () => terminals.rows(where, orders, count),
  read: () => terminals.read(where, orders, count)
});
//# sourceMappingURL=readBuilder.js.map