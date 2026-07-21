"use strict";

/** Create a plain immutable read builder whose terminals delegate to the model read engine. */
export const createReadBuilder = (where, terminals, orders = [], count = undefined, required = [], projection = {}) => ({
  orderBy: (field, direction = 'asc') => createReadBuilder(where, terminals, [...orders, {
    field,
    direction
  }], count, required, projection),
  limit: nextCount => createReadBuilder(where, terminals, orders, nextCount, required, projection),
  require: (...fields) => createReadBuilder(where, terminals, orders, count, [...required, ...fields], projection),
  select: selector => createReadBuilder(where, terminals, orders, count, required, {
    select: selector
  }),
  rows: () => terminals.rows(where, orders, count, required, projection),
  last: () => {
    const rows = terminals.rows(where, orders, count, required, projection);
    return rows[rows.length - 1];
  },
  pluck: field => terminals.pluck(where, orders, count, required, projection, field),
  exists: () => terminals.exists(where, required)
});
//# sourceMappingURL=readBuilder.js.map