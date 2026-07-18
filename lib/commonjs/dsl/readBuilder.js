"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createReadBuilder = void 0;
/** Create a plain immutable read builder whose terminals delegate to the model read engine. */
const createReadBuilder = (where, terminals, orders = [], count = undefined, required = []) => ({
  orderBy: (field, direction = 'asc') => createReadBuilder(where, terminals, [...orders, {
    field,
    direction
  }], count, required),
  limit: nextCount => createReadBuilder(where, terminals, orders, nextCount, required),
  require: (...fields) => createReadBuilder(where, terminals, orders, count, [...required, ...fields]),
  rows: () => terminals.rows(where, orders, count, required),
  read: () => terminals.read(where, orders, count, required)
});
exports.createReadBuilder = createReadBuilder;
//# sourceMappingURL=readBuilder.js.map