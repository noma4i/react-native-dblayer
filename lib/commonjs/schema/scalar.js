"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.scalar = void 0;
var _fieldCodec = require("./fieldCodec.js");
const createScalarValue = (codec, errorMessage) => ({
  read: codec.read,
  require: (value, label) => {
    const parsed = codec.read(value);
    if (parsed === undefined) throw new Error(errorMessage(label));
    return parsed;
  }
});

/**
 * Read individual transport values through the same codecs as `f.*` fields.
 *
 * `read` returns the stored scalar type or `undefined`; `require` returns the stored type or throws
 * an error naming the invalid input.
 */
const scalar = exports.scalar = {
  str: createScalarValue(_fieldCodec.scalarFieldCodecs.str, label => `${label} must be a string`),
  num: createScalarValue(_fieldCodec.scalarFieldCodecs.num, label => `${label} must be a finite number`),
  int: createScalarValue(_fieldCodec.scalarFieldCodecs.int, label => `${label} must be a safe integer`),
  date: createScalarValue(_fieldCodec.scalarFieldCodecs.date, label => `${label} must be a valid date`),
  bool: createScalarValue(_fieldCodec.scalarFieldCodecs.bool, label => `${label} must be a boolean`),
  id: createScalarValue(_fieldCodec.scalarFieldCodecs.id, label => `${label} is required`),
  enum: values => createScalarValue((0, _fieldCodec.createEnumFieldCodec)(values), label => `${label} must be one of the declared values`)
};
//# sourceMappingURL=scalar.js.map