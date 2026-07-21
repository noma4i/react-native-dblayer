"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.readObjectField = exports.preserveNull = exports.fieldSpecSparseRead = exports.createFieldSpec = void 0;
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
/** Read a selected raw value into a stored field value. */

/** Select the raw source value for a field from an input object and key. */

const fieldSpecSparseRead = exports.fieldSpecSparseRead = Symbol('fieldSpecSparseRead');
/** Read `input[key]` when input is an object, otherwise return undefined. */
const readObjectField = (input, key) => {
  if (!(0, _normalizeHelpers.isRecord)(input)) return undefined;
  return input[key];
};

/** Read an own key from a source object, otherwise return undefined. */
exports.readObjectField = readObjectField;
const readSourceKey = (source, key) => {
  if (!(0, _normalizeHelpers.isRecord)(source)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(source, key)) return undefined;
  return source[key];
};
const nullableMode = mode => mode === 'optional' || mode === 'optionalNullable' ? 'optionalNullable' : 'nullable';
const optionalMode = mode => mode === 'nullable' || mode === 'optionalNullable' ? 'optionalNullable' : 'optional';

/** Wrap a value reader so explicit null is preserved. */
const preserveNull = readValue => value => {
  if (value === null) return null;
  return readValue(value);
};

/** Create a chainable field spec from low-level reader functions. */
exports.preserveNull = preserveNull;
const createFieldSpec = options => {
  const spec = {
    mode: options.mode,
    readValue(value) {
      const output = options.readValue(value);
      if (output === undefined && options.defaultNull && value === undefined) return null;
      return output;
    },
    [fieldSpecSparseRead](input, key) {
      try {
        return options.readValue(options.selectSource(input, key));
      } catch {
        return undefined;
      }
    },
    read(input, key) {
      try {
        const source = options.selectSource(input, key);
        return spec.readValue(source);
      } catch {
        return undefined;
      }
    },
    nullable() {
      return createFieldSpec({
        ...options,
        mode: nullableMode(options.mode),
        readValue: options.readNullableValue
      });
    },
    optional() {
      return createFieldSpec({
        ...options,
        mode: optionalMode(options.mode)
      });
    },
    nullDefault() {
      return createFieldSpec({
        ...options,
        mode: 'nullable',
        readValue: options.readNullableValue,
        defaultNull: true
      });
    },
    default(value) {
      return createFieldSpec({
        ...options,
        factoryDefault: value
      });
    },
    from: selector => createFieldSpec({
      ...options,
      selectSource: input => selector(input)
    }),
    fromKey: (key, source) => createFieldSpec({
      ...options,
      selectSource: input => readSourceKey(source ? source(input) : input, key)
    })
  };
  if (Object.prototype.hasOwnProperty.call(options, 'factoryDefault')) {
    spec.factoryDefault = options.factoryDefault;
  }
  return spec;
};
exports.createFieldSpec = createFieldSpec;
//# sourceMappingURL=fieldSpec.js.map