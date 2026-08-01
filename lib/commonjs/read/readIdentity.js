"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.incrementalSignature = void 0;
var _serialize = require("../core/serialize.js");
/** Canonical semantic descriptors preserve object identity only where leaf values require it. */
const incrementalSignature = (kind, ...values) => (0, _serialize.compositeKey)(kind, ...values.map(_serialize.semanticValue));
exports.incrementalSignature = incrementalSignature;
//# sourceMappingURL=readIdentity.js.map