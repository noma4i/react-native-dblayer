"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createReadBuilder = void 0;
/** Create a plain immutable read builder whose terminals delegate to the model read engine. */
const createReadBuilder = (where, terminals, orders = [], count = undefined, required = [], projection = {}) => ({
  orderBy: (field, direction = 'asc') => createReadBuilder(where, terminals, [...orders, {
    field,
    direction
  }], count, required, projection),
  limit: nextCount => createReadBuilder(where, terminals, orders, nextCount, required, projection),
  require: (...fields) => createReadBuilder(where, terminals, orders, count, [...required, ...fields], projection),
  select: selector => createReadBuilder(where, terminals, orders, count, required, {
    select: selector
  }),
  rows: () => terminals.rows(where, orders, count, required, projection)
});
exports.createReadBuilder = createReadBuilder;
//# sourceMappingURL=readBuilder.js.map