"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createReadBuilder = void 0;
/** Create a plain immutable read builder whose terminals delegate to the model read engine. */
const createReadBuilder = (where, terminals, orders = [], count = undefined) => ({
  orderBy: (field, direction = 'asc') => createReadBuilder(where, terminals, [...orders, {
    field,
    direction
  }], count),
  limit: nextCount => createReadBuilder(where, terminals, orders, nextCount),
  rows: () => terminals.rows(where, orders, count),
  read: () => terminals.read(where, orders, count)
});
exports.createReadBuilder = createReadBuilder;
//# sourceMappingURL=readBuilder.js.map