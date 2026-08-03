"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useDbSubscriptions = useDbSubscriptions;
var _react = require("react");
var _modelEventRegistry = require("../core/modelEventRegistry.js");
/**
 * Activate every registered model event while the owning application surface is active.
 *
 * @param active Whether the owning application surface currently receives live events.
 */
function useDbSubscriptions(active) {
  (0, _react.useEffect)(() => {
    if (!active) return undefined;
    const release = (0, _modelEventRegistry.acquireModelSubscriptions)();
    return () => release();
  }, [active]);
}
//# sourceMappingURL=useDbSubscriptions.js.map