"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.readObjectField = exports.preserveNull = exports.createFieldSpec = void 0;
const readObjectField = (input, key) => {
  if (typeof input !== 'object' || input === null) return undefined;
  return input[key];
};
exports.readObjectField = readObjectField;
const nullableMode = mode => mode === 'optional' || mode === 'optionalNullable' ? 'optionalNullable' : 'nullable';
const optionalMode = mode => mode === 'nullable' || mode === 'optionalNullable' ? 'optionalNullable' : 'optional';
const preserveNull = readValue => value => {
  if (value === null) return null;
  return readValue(value);
};
exports.preserveNull = preserveNull;
const createFieldSpec = options => {
  const spec = {
    mode: options.mode,
    readValue(value) {
      const output = options.readValue(value);
      if (output === undefined && options.defaultNull && value === undefined) return null;
      return output;
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
    from: selector => createFieldSpec({
      mode: options.mode,
      selectSource: input => selector(input),
      readValue: options.readValue,
      readNullableValue: options.readNullableValue,
      defaultNull: options.defaultNull
    })
  };
  return spec;
};
exports.createFieldSpec = createFieldSpec;
//# sourceMappingURL=fieldSpec.js.map