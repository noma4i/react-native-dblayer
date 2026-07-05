"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useMapById = void 0;
var _react = require("react");
const useMapById = items => {
  return (0, _react.useMemo)(() => {
    const map = new Map();
    for (const item of items) {
      map.set(item.id, item);
    }
    return map;
  }, [items]);
};
exports.useMapById = useMapById;
//# sourceMappingURL=mapById.js.map