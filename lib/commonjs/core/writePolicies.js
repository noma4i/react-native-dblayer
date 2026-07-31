"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.compileWritePolicies = void 0;
var _invariants = require("./invariants.js");
var _diagnostics = require("./diagnostics.js");
var _serialize = require("./serialize.js");
var _fieldCodec = require("../schema/fieldCodec.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
const isPresent = value => {
  if (value == null) return false;
  if (typeof value === 'string' || Array.isArray(value)) return value.length > 0;
  if ((0, _normalizeHelpers.isNonArrayRecord)(value)) return Object.keys(value).length > 0;
  return true;
};

/** Read a dot-separated object path without traversing arrays or throwing on absent intermediate values. */
const readPath = (row, path) => {
  let value = row;
  for (const part of path.split('.')) {
    if (!(0, _normalizeHelpers.isNonArrayRecord)(value)) return undefined;
    value = value[part];
  }
  return value;
};
const compareTupleValue = (incoming, current) => {
  if (incoming == null) return current == null ? 0 : -1;
  if (current == null) return 1;
  const incomingNumber = _fieldCodec.scalarFieldCodecs.num.read(incoming);
  const currentNumber = _fieldCodec.scalarFieldCodecs.num.read(current);
  if (incomingNumber !== undefined && currentNumber !== undefined) return incomingNumber - currentNumber;
  return (0, _serialize.compareCodepoints)(String(incoming), String(current));
};
const isIncomingTupleNewer = (paths, incoming, previous) => {
  for (const path of paths) {
    const comparison = compareTupleValue(readPath(incoming, path), readPath(previous, path));
    if (comparison !== 0) return comparison > 0;
  }
  return false;
};
const isIncomingNewerBy = (path, incoming, previous) => (0, _invariants.isIncomingNewer)(_fieldCodec.scalarFieldCodecs.date.read(readPath(previous, path)), _fieldCodec.scalarFieldCodecs.date.read(readPath(incoming, path)));
const ladderRank = (value, tiers) => tiers.findIndex(tier => tier.includes(String(value)));
const acceptsMonotonic = (spec, fields, incoming, previous, modelId) => {
  if ('newerBy' in spec) return isIncomingNewerBy(spec.newerBy, incoming, previous);
  if ('tuple' in spec) return isIncomingTupleNewer(spec.tuple, incoming, previous);
  if ('nonEmpty' in spec) return fields.every(field => field in incoming && isPresent(incoming[field]));
  if ('ladder' in spec) {
    const incomingValue = readPath(incoming, spec.ladder.path);
    const previousValue = readPath(previous, spec.ladder.path);
    if (incomingValue == null || previousValue == null) return true;
    const incomingRank = ladderRank(incomingValue, spec.ladder.tiers);
    if (incomingRank < 0) {
      (0, _diagnostics.noteDataLoss)('unranked-ladder-value', modelId, 1);
      return false;
    }
    return incomingRank >= ladderRank(previousValue, spec.ladder.tiers);
  }
  if ('present' in spec) return readPath(incoming, spec.present) != null;
  if ('equal' in spec) return Object.is(readPath(incoming, spec.equal), readPath(previous, spec.equal));
  if ('all' in spec) return spec.all.every(item => acceptsMonotonic(item, fields, incoming, previous, modelId));
  return spec.any.some(item => acceptsMonotonic(item, fields, incoming, previous, modelId));
};
const appliesMonotonic = (policy, origin) => origin !== 'replace' && (policy.on ?? ['snapshot', 'event']).includes(origin);
const applyNestedKeyPolicy = (current, incoming, policy) => {
  if (policy === 'server') return incoming;
  if (policy === 'continuity') return incoming == null ? current : incoming;
  if (policy === 'nonEmpty') return isPresent(incoming) ? incoming : current;
  const currentNumber = _fieldCodec.scalarFieldCodecs.num.read(current);
  const incomingNumber = _fieldCodec.scalarFieldCodecs.num.read(incoming);
  return incomingNumber === undefined || incomingNumber <= 0 ? currentNumber !== undefined && currentNumber > 0 ? current : incoming : incoming;
};
const applyNestedKeys = (previousValue, incomingValue, policy) => {
  if (!(0, _normalizeHelpers.isNonArrayRecord)(incomingValue) || !(0, _normalizeHelpers.isNonArrayRecord)(previousValue)) return incomingValue;
  const result = {
    ...previousValue,
    ...incomingValue
  };
  for (const key of Object.keys(incomingValue)) {
    const keyPolicy = policy.keys[key] ?? policy.rest ?? 'server';
    const resolved = applyNestedKeyPolicy(previousValue[key], incomingValue[key], keyPolicy);
    if (resolved === undefined) delete result[key];else result[key] = resolved;
  }
  return result;
};
const restoreField = (effective, previous, field) => {
  if (field in previous) effective[field] = previous[field];else delete effective[field];
};
const applyPolicy = (policy, fields, previous, effective, ctx, modelId) => {
  if (policy === 'server') return;
  if (policy === 'local') {
    if (ctx.origin !== 'patch') {
      for (const field of fields) restoreField(effective, previous, field);
    }
    return;
  }
  if (policy === 'continuity') {
    for (const field of fields) if (field in effective && effective[field] == null) restoreField(effective, previous, field);
    return;
  }
  if ('snapshot' in policy) {
    for (const field of fields) if (field in effective) effective[field] = (0, _normalizeHelpers.isNonArrayRecord)(previous[field]) && (0, _normalizeHelpers.isNonArrayRecord)(effective[field]) ? {
      ...previous[field],
      ...effective[field]
    } : effective[field];
    return;
  }
  if ('keys' in policy) {
    for (const field of fields) if (field in effective) effective[field] = applyNestedKeys(previous[field], effective[field], policy);
    return;
  }
  if (!appliesMonotonic(policy, ctx.origin)) return;
  if (!acceptsMonotonic(policy.monotonic, fields, effective, previous, modelId)) {
    for (const field of fields) restoreField(effective, previous, field);
  }
};

/**
 * Compile a closed, model-owned write declaration into the sole entity write gate.
 *
 * Monotonic policies run only for `snapshot` and `event` unless `on` narrows those origins; replace
 * remains authoritative for monotonic groups. `server` uses incoming values, `local` changes only
 * through a patch, `continuity` retains nullish values, `snapshot` shallow-folds objects, and
 * nested-key policies protect declared object keys. `newerBy` normalizes values through the date
 * field codec before `isIncomingNewer`.
 */
const compileWritePolicies = (groups, modelId) => (previous, incoming, ctx) => {
  const effective = {
    ...previous,
    ...incoming
  };
  for (const group of groups) {
    const policies = Array.isArray(group.policy) ? group.policy : [group.policy];
    for (const policy of policies) applyPolicy(policy, group.fields, previous, effective, ctx, modelId);
  }
  return effective;
};
exports.compileWritePolicies = compileWritePolicies;
//# sourceMappingURL=writePolicies.js.map