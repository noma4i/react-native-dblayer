"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.scalarFieldCodecs = exports.defineFieldCodec = exports.createEnumFieldCodec = void 0;
/** Create one typed conversion boundary for a field kind. */
const defineFieldCodec = read => ({
  read
});

/** Create a runtime-validating codec for one declared string enum. */
exports.defineFieldCodec = defineFieldCodec;
const createEnumFieldCodec = values => {
  const allowed = new Set(values);
  return {
    read: value => allowed.has(value) ? value : undefined
  };
};
exports.createEnumFieldCodec = createEnumFieldCodec;
const readString = value => typeof value === 'string' ? value : undefined;
const readNumber = value => {
  const numberValue = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isFinite(numberValue)) return undefined;
  const finiteNumber = numberValue;
  return Object.is(finiteNumber, -0) ? 0 : finiteNumber;
};
const readInteger = value => {
  const numberValue = readNumber(value);
  return Number.isSafeInteger(numberValue) ? numberValue : undefined;
};
const readDate = value => {
  if (typeof value === 'string') return Number.isNaN(Date.parse(value)) ? undefined : value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (Number.isFinite(value)) return new Date(value).toISOString();
  return undefined;
};
const booleanValues = new Map([[true, true], [false, false], ['true', true], ['false', false]]);
const readBoolean = value => booleanValues.get(value);
const readId = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const id = String(value);
  return id === '' ? undefined : id;
};

/** Canonical codecs used by scalar field builders and internal field-aware reads. */
const scalarFieldCodecs = exports.scalarFieldCodecs = {
  str: {
    read: readString
  },
  num: {
    read: readNumber
  },
  int: {
    read: readInteger
  },
  date: {
    read: readDate
  },
  bool: {
    read: readBoolean
  },
  id: {
    read: readId
  }
};
//# sourceMappingURL=fieldCodec.js.map