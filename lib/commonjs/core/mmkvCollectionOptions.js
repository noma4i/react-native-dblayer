"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.mmkvCollectionOptions = void 0;
var _db = require("@tanstack/db");
var _storage = require("./storage.js");
/** Build TanStack DB local-storage collection options backed by the configured storage adapter. */
const mmkvCollectionOptions = config => {
  const storage = (0, _storage.getDbStorageAdapter)();
  return (0, _db.localStorageCollectionOptions)({
    id: config.id,
    storageKey: `tanstack-db-${config.id}`,
    storage,
    storageEventApi: storage.eventApi,
    getKey: config.getKey,
    autoIndex: 'eager',
    defaultIndexType: _db.BasicIndex
  });
};
exports.mmkvCollectionOptions = mmkvCollectionOptions;
//# sourceMappingURL=mmkvCollectionOptions.js.map