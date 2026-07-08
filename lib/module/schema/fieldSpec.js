"use strict";

/** Read a selected raw value into a stored field value. */

/** Select the raw source value for a field from an input object and key. */

/** Read `input[key]` when input is an object, otherwise return undefined. */
export const readObjectField = (input, key) => {
  if (typeof input !== 'object' || input === null) return undefined;
  return input[key];
};
const nullableMode = mode => mode === 'optional' || mode === 'optionalNullable' ? 'optionalNullable' : 'nullable';
const optionalMode = mode => mode === 'nullable' || mode === 'optionalNullable' ? 'optionalNullable' : 'optional';

/** Wrap a value reader so explicit null is preserved. */
export const preserveNull = readValue => value => {
  if (value === null) return null;
  return readValue(value);
};

/** Create a chainable field spec from low-level reader functions. */
export const createFieldSpec = options => {
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
    default(value) {
      return createFieldSpec({
        ...options,
        factoryDefault: value
      });
    },
    from: selector => createFieldSpec({
      ...options,
      selectSource: input => selector(input)
    })
  };
  if (Object.prototype.hasOwnProperty.call(options, 'factoryDefault')) {
    spec.factoryDefault = options.factoryDefault;
  }
  return spec;
};
//# sourceMappingURL=fieldSpec.js.map