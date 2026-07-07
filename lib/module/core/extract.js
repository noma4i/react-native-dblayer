"use strict";

import { mergeSyncContract } from "../utils/serverSync.js";
import { castNodes } from "../utils/typeBoundary.js";

/** Applies a resolved extract payload to application collections. */

/** Resolves a mutation extract spec with a server result. */

const defaultDbExtractSink = () => {};
const defaultDbMutationExtractResolver = extractSpec => extractSpec;
let currentDbExtractSink = defaultDbExtractSink;
let currentDbMutationExtractResolver = defaultDbMutationExtractResolver;

/** Set the sink used for query and mutation side-load payloads. */
export const setDbExtractSink = sink => {
  currentDbExtractSink = sink;
};

/** Get the currently configured extract sink. */
export const getDbExtractSink = () => currentDbExtractSink;

/** Set the resolver used to turn mutation extract specs into payloads. */
export const setDbMutationExtractResolver = resolver => {
  currentDbMutationExtractResolver = resolver;
};

/** Get the currently configured mutation extract resolver. */
export const getDbMutationExtractResolver = () => currentDbMutationExtractResolver;
const isRecord = value => typeof value === 'object' && value !== null;
const liftExtractNodes = value => {
  if (value == null) return [];
  if (Array.isArray(value)) return value.filter(item => item != null);
  return [value];
};
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
  if (preset === true) {
    return entry.many === false ? entry.read(result) : liftExtractNodes(entry.read(result));
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
export const createMutationExtractResolver = presetTable => (extractSpec, result) => {
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
const isModelSink = sink => isRecord(sink) && typeof sink.applyServerData === 'function';

/**
 * Build an extract sink from a declarative sink table.
 * Sink keys run in declaration order.
 */
export const createExtractSink = sinkTable => (extractResult, source) => {
  if (!isRecord(extractResult)) return;
  for (const key of Object.keys(sinkTable)) {
    const payload = extractResult[key];
    if (isEmptyExtractValue(payload)) continue;
    const sink = sinkTable[key];
    if (isModelSink(sink)) {
      const nodes = liftExtractNodes(payload);
      if (nodes.length === 0) continue;
      sink.applyServerData(castNodes(nodes), mergeSyncContract(source));
    } else {
      sink(payload, source);
    }
  }
};
//# sourceMappingURL=extract.js.map