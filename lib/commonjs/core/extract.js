"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.setDbMutationExtractResolver = exports.setDbExtractSink = exports.liftExtractNodes = exports.getDbMutationExtractResolver = exports.getDbExtractSink = exports.createMutationExtractResolver = exports.createExtractSink = void 0;
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
var _serverSync = require("../utils/serverSync.js");
var _typeBoundary = require("../utils/typeBoundary.js");
/** Applies a resolved extract payload to application collections. */

/** Resolves a mutation extract spec with a server result. */

/**
 * Derive the legal mutation extract config shape from a mutation extract preset table.
 *
 * The resulting spec accepts only declared preset keys. Each key supports `true` or a selector whose
 * result parameter matches that preset entry's `TResult`.
 */

const defaultDbExtractSink = () => {};
const defaultDbMutationExtractResolver = extractSpec => extractSpec;
let currentDbExtractSink = defaultDbExtractSink;
let currentDbMutationExtractResolver = defaultDbMutationExtractResolver;

/** Set the sink used for query and mutation side-load payloads. */
const setDbExtractSink = sink => {
  currentDbExtractSink = sink;
};

/** Get the currently configured extract sink. */
exports.setDbExtractSink = setDbExtractSink;
const getDbExtractSink = () => currentDbExtractSink;

/** Set the resolver used to turn mutation extract specs into payloads. */
exports.getDbExtractSink = getDbExtractSink;
const setDbMutationExtractResolver = resolver => {
  currentDbMutationExtractResolver = resolver;
};

/** Get the currently configured mutation extract resolver. */
exports.setDbMutationExtractResolver = setDbMutationExtractResolver;
const getDbMutationExtractResolver = () => currentDbMutationExtractResolver;

/**
 * Normalize a mutation extract value into a compact array of non-null nodes.
 *
 * @param value Single node, node array, or nullish extract result.
 * @returns A node array with nullish entries removed.
 */
exports.getDbMutationExtractResolver = getDbMutationExtractResolver;
const liftExtractNodes = value => {
  if (value == null) return [];
  if (Array.isArray(value)) return value.filter(item => item != null);
  return [value];
};
exports.liftExtractNodes = liftExtractNodes;
const isEmptyExtractValue = value => value == null || Array.isArray(value) && value.length === 0;

/**
 * Merge a newly resolved preset value into an in-progress extract output under a shared sink key.
 *
 * Two or more mutation extract presets may target the same sink key (e.g. a `wallet` preset and a
 * `currentUser` preset both routing into a `currentUser` sink). Every combination is additive - no
 * combination silently drops a previously resolved value:
 *
 * - No existing value: the new value is stored as-is (array or single value, unchanged).
 * - Existing array + new array: concatenated (`existing.concat(value)`).
 * - Existing array + new single value: appended (`existing.concat([value])`).
 * - Existing single value + new array: prepended (`[existing].concat(value)`).
 * - Existing single value + new single value: promoted to a two-element array (`[existing, value]`),
 *   declaration order preserved. `createExtractSink` always runs `liftExtractNodes` on a sink's
 *   payload before dispatch, so a promoted array reaches a model sink exactly like any other array
 *   payload; a custom function sink receives the same lifted array as its `payload` argument.
 *
 * @param output Extract result accumulator, keyed by sink key.
 * @param key Sink key the resolved value should be merged into.
 * @param value Newly resolved preset value (array or single value).
 */
const appendExtractValue = (output, key, value) => {
  const existing = output[key];
  if (existing === undefined) {
    output[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    output[key] = Array.isArray(value) ? existing.concat(value) : existing.concat([value]);
    return;
  }
  output[key] = Array.isArray(value) ? [existing].concat(value) : [existing, value];
};
const describePresetValue = value => {
  if (typeof value === 'string') return `string "${value}"`;
  if (typeof value === 'symbol' || typeof value === 'function') return typeof value;
  try {
    return `${typeof value} ${JSON.stringify(value)}`;
  } catch {
    return typeof value;
  }
};

/**
 * Resolve one mutation extract preset entry's value for the current result.
 *
 * `false`/`undefined`/`null` are the only recognized "not requested" markers and resolve to `undefined`
 * (skipped by the caller's `isEmptyExtractValue` check) exactly as before. Any other value that is
 * neither `true` nor a selector function is a configuration mistake, not a legitimate skip - e.g.
 * `extract: { chat: 'true' }` or `{ chat: 1 }` - and throws instead of silently extracting nothing.
 */
const resolvePresetValue = (preset, entry, result) => {
  const readValue = () => typeof entry.read === 'string' ? result?.[entry.read] : entry.read(result);
  if (preset === true) {
    return entry.many === false ? readValue() : liftExtractNodes(readValue());
  }
  if (typeof preset === 'function') {
    const selected = preset(result);
    return entry.many === false ? selected : liftExtractNodes(selected);
  }
  if (preset === false || preset == null) return undefined;
  throw new Error(`Invalid mutation extract preset for sink "${entry.sink}": expected \`true\` or a selector function, received ${describePresetValue(preset)}.`);
};

/**
 * Build a mutation extract resolver from a declarative preset table.
 * Boolean presets use the table reader; selector presets override the reader.
 */
const createMutationExtractResolver = presetTable => (extractSpec, result) => {
  if (!(0, _normalizeHelpers.isRecord)(extractSpec) || result == null) return undefined;
  const output = {};
  for (const presetKey of Object.keys(presetTable)) {
    const entry = presetTable[presetKey];
    const value = resolvePresetValue(extractSpec[presetKey], entry, result);
    if (isEmptyExtractValue(value)) continue;
    appendExtractValue(output, entry.sink, value);
  }
  return Object.keys(output).length > 0 ? output : undefined;
};
exports.createMutationExtractResolver = createMutationExtractResolver;
const isModelSink = sink => (0, _normalizeHelpers.isRecord)(sink) && typeof sink.applyServerData === 'function';

/**
 * Build an extract sink from a declarative sink table.
 * Model sinks run first in declaration order, then custom function sinks run in declaration order.
 * Custom sinks can derive or patch rows inserted by model sinks from the same extract payload, including
 * when the custom key is declared before the model key.
 *
 * Every sink key's payload runs through `liftExtractNodes` before dispatch, so both branches see an
 * array regardless of whether the resolver produced a single value or an array (including the merged
 * multi-preset arrays `appendExtractValue` can now produce for a shared sink key): a model sink's
 * `applyServerData` always receives an array, and a custom function sink's `payload` argument is
 * always an array too.
 */
const createExtractSink = sinkTable => (extractResult, source) => {
  if (!(0, _normalizeHelpers.isRecord)(extractResult)) return;
  const dispatchSink = key => {
    const payload = extractResult[key];
    if (isEmptyExtractValue(payload)) return;
    const sink = sinkTable[key];
    const nodes = liftExtractNodes(payload);
    if (nodes.length === 0) return;
    if (isModelSink(sink)) {
      sink.applyServerData((0, _typeBoundary.castNodes)(nodes), sink.contract ? sink.contract(nodes, source) : (0, _serverSync.mergeSyncContract)(source));
    } else {
      sink(nodes, source);
    }
  };
  const keys = Object.keys(sinkTable);
  for (const key of keys) {
    if (isModelSink(sinkTable[key])) {
      dispatchSink(key);
    }
  }
  for (const key of keys) {
    if (!isModelSink(sinkTable[key])) {
      dispatchSink(key);
    }
  }
};
exports.createExtractSink = createExtractSink;
//# sourceMappingURL=extract.js.map