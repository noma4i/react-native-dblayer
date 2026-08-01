"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.residencySnapshot = exports.registerResidency = void 0;
const gauges = new Set();

/**
 * Declare an internal collection whose entries must drain when their owner goes away. Counters
 * measure work that HAPPENED; a gauge measures what is still HELD, which is the only way a test can
 * tell a released entry from one that was never released - the two are otherwise indistinguishable,
 * and a leak looks exactly like correct behaviour until memory runs out.
 *
 * @param name Collection identity; several instances may share one name and their sizes are summed.
 * @param size Reads the instance's current entry count.
 * @returns Unregister function - call it when the instance itself is disposed.
 */
const registerResidency = (name, size) => {
  const gauge = {
    name,
    size
  };
  gauges.add(gauge);
  return () => {
    gauges.delete(gauge);
  };
};

/** Current resident entry count of every registered collection, summed per name. */
exports.registerResidency = registerResidency;
const residencySnapshot = () => {
  const snapshot = {};
  for (const gauge of gauges) snapshot[gauge.name] = (snapshot[gauge.name] ?? 0) + gauge.size();
  return snapshot;
};
exports.residencySnapshot = residencySnapshot;
//# sourceMappingURL=residency.js.map