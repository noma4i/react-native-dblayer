"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.setDbMutationExtractResolver = exports.setDbExtractSink = exports.liftExtractNodes = exports.getDbMutationExtractResolver = exports.getDbExtractSink = exports.createMutationExtractResolver = exports.createExtractSink = void 0;
var _serverSync = require("../utils/serverSync.js");
var _typeBoundary = require("../utils/typeBoundary.js");
/** Applies a resolved extract payload to application collections. */

/** Resolves a mutation extract spec with a server result. */

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
exports.getDbMutationExtractResolver = getDbMutationExtractResolver;
const isRecord = value => typeof value === 'object' && value !== null;
const liftExtractNodes = value => {
  if (value == null) return [];
  if (Array.isArray(value)) return value.filter(item => item != null);
  return [value];
};
exports.liftExtractNodes = liftExtractNodes;
const isEmptyExtractValue = value => value == null || Array.isArray(value) && value.length === 0;
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
  output[key] = Array.isArray(value) ? [existing].concat(value) : value;
};
const resolvePresetValue = (preset, entry, result) => {
  const readValue = () => typeof entry.read === 'string' ? result?.[entry.read] : entry.read(result);
  if (preset === true) {
    return entry.many === false ? readValue() : liftExtractNodes(readValue());
  }
  if (typeof preset === 'function') {
    const selected = preset(result);
    return entry.many === false ? selected : liftExtractNodes(selected);
  }
  return undefined;
};

/**
 * Build a mutation extract resolver from a declarative preset table.
 * Boolean presets use the table reader; selector presets override the reader.
 */
const createMutationExtractResolver = presetTable => (extractSpec, result) => {
  if (!isRecord(extractSpec) || result == null) return undefined;
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
const isModelSink = sink => isRecord(sink) && typeof sink.applyServerData === 'function';

/**
 * Build an extract sink from a declarative sink table.
 * Sink keys run in declaration order.
 */
const createExtractSink = sinkTable => (extractResult, source) => {
  if (!isRecord(extractResult)) return;
  for (const key of Object.keys(sinkTable)) {
    const payload = extractResult[key];
    if (isEmptyExtractValue(payload)) continue;
    const sink = sinkTable[key];
    const nodes = liftExtractNodes(payload);
    if (nodes.length === 0) continue;
    if (isModelSink(sink)) {
      sink.applyServerData((0, _typeBoundary.castNodes)(nodes), (0, _serverSync.mergeSyncContract)(source));
    } else {
      sink(nodes, source);
    }
  }
};
exports.createExtractSink = createExtractSink;
//# sourceMappingURL=extract.js.map