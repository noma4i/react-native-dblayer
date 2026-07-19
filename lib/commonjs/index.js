"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
Object.defineProperty(exports, "DbProvider", {
  enumerable: true,
  get: function () {
    return _DbProvider.DbProvider;
  }
});
Object.defineProperty(exports, "belongsTo", {
  enumerable: true,
  get: function () {
    return _relations.belongsTo;
  }
});
Object.defineProperty(exports, "bootDb", {
  enumerable: true,
  get: function () {
    return _lifecycle.bootDb;
  }
});
Object.defineProperty(exports, "castNode", {
  enumerable: true,
  get: function () {
    return _typeBoundary.castNode;
  }
});
Object.defineProperty(exports, "castNodes", {
  enumerable: true,
  get: function () {
    return _typeBoundary.castNodes;
  }
});
Object.defineProperty(exports, "collectGarbage", {
  enumerable: true,
  get: function () {
    return _gc.collectGarbage;
  }
});
Object.defineProperty(exports, "configureDb", {
  enumerable: true,
  get: function () {
    return _configure.configureDb;
  }
});
Object.defineProperty(exports, "createDbSubscriptionEffects", {
  enumerable: true,
  get: function () {
    return _subscriptionRuntime.createDbSubscriptionEffects;
  }
});
Object.defineProperty(exports, "createDbSubscriptionRuntime", {
  enumerable: true,
  get: function () {
    return _subscriptionRuntime.createDbSubscriptionRuntime;
  }
});
Object.defineProperty(exports, "createIdArrayPatcher", {
  enumerable: true,
  get: function () {
    return _runtimePrimitives.createIdArrayPatcher;
  }
});
Object.defineProperty(exports, "createKeyedArrayPatcher", {
  enumerable: true,
  get: function () {
    return _runtimePrimitives.createKeyedArrayPatcher;
  }
});
Object.defineProperty(exports, "createModelStatusPoller", {
  enumerable: true,
  get: function () {
    return _modelStatusPoller.createModelStatusPoller;
  }
});
Object.defineProperty(exports, "createNestedObjectPatcher", {
  enumerable: true,
  get: function () {
    return _runtimePrimitives.createNestedObjectPatcher;
  }
});
Object.defineProperty(exports, "createSingletonStatics", {
  enumerable: true,
  get: function () {
    return _runtimePrimitives.createSingletonStatics;
  }
});
Object.defineProperty(exports, "createThrottledSingleFlight", {
  enumerable: true,
  get: function () {
    return _runtimePrimitives.createThrottledSingleFlight;
  }
});
Object.defineProperty(exports, "dedupeIds", {
  enumerable: true,
  get: function () {
    return _uniqueIds.dedupeIds;
  }
});
Object.defineProperty(exports, "defineCommand", {
  enumerable: true,
  get: function () {
    return _defineCommand.defineCommand;
  }
});
Object.defineProperty(exports, "defineDbSubscriptionEntry", {
  enumerable: true,
  get: function () {
    return _subscriptionRuntime.defineDbSubscriptionEntry;
  }
});
Object.defineProperty(exports, "defineFetch", {
  enumerable: true,
  get: function () {
    return _defineFetch.defineFetch;
  }
});
Object.defineProperty(exports, "defineModel", {
  enumerable: true,
  get: function () {
    return _defineModel.defineModel;
  }
});
Object.defineProperty(exports, "defineShape", {
  enumerable: true,
  get: function () {
    return _shape.defineShape;
  }
});
Object.defineProperty(exports, "emptyIds", {
  enumerable: true,
  get: function () {
    return _uniqueIds.emptyIds;
  }
});
Object.defineProperty(exports, "f", {
  enumerable: true,
  get: function () {
    return _f.f;
  }
});
Object.defineProperty(exports, "flushPersistence", {
  enumerable: true,
  get: function () {
    return _configure.flushPersistence;
  }
});
Object.defineProperty(exports, "generateTempId", {
  enumerable: true,
  get: function () {
    return _generateTempId.generateTempId;
  }
});
Object.defineProperty(exports, "getDbTransport", {
  enumerable: true,
  get: function () {
    return _transport.getDbTransport;
  }
});
Object.defineProperty(exports, "hasMany", {
  enumerable: true,
  get: function () {
    return _relations.hasMany;
  }
});
Object.defineProperty(exports, "hasOne", {
  enumerable: true,
  get: function () {
    return _relations.hasOne;
  }
});
Object.defineProperty(exports, "isIncomingNewer", {
  enumerable: true,
  get: function () {
    return _invariants.isIncomingNewer;
  }
});
Object.defineProperty(exports, "isTempId", {
  enumerable: true,
  get: function () {
    return _generateTempId.isTempId;
  }
});
Object.defineProperty(exports, "mergeOptimisticMedia", {
  enumerable: true,
  get: function () {
    return _optimisticMedia.mergeOptimisticMedia;
  }
});
Object.defineProperty(exports, "mergeOptimisticSnapshot", {
  enumerable: true,
  get: function () {
    return _mergeOptimisticSnapshot.mergeOptimisticSnapshot;
  }
});
Object.defineProperty(exports, "mmkvStoragePlane", {
  enumerable: true,
  get: function () {
    return _storagePlane.mmkvStoragePlane;
  }
});
Object.defineProperty(exports, "patchWhenRowExists", {
  enumerable: true,
  get: function () {
    return _rowWaiters.patchWhenRowExists;
  }
});
Object.defineProperty(exports, "pickDefined", {
  enumerable: true,
  get: function () {
    return _pickDefined.pickDefined;
  }
});
Object.defineProperty(exports, "pickPresent", {
  enumerable: true,
  get: function () {
    return _pickDefined.pickPresent;
  }
});
Object.defineProperty(exports, "projectShape", {
  enumerable: true,
  get: function () {
    return _shape.projectShape;
  }
});
Object.defineProperty(exports, "purgeForeignStorageKeys", {
  enumerable: true,
  get: function () {
    return _configure.purgeForeignStorageKeys;
  }
});
Object.defineProperty(exports, "readShape", {
  enumerable: true,
  get: function () {
    return _shape.readShape;
  }
});
Object.defineProperty(exports, "readShapeOrThrow", {
  enumerable: true,
  get: function () {
    return _shape.readShapeOrThrow;
  }
});
Object.defineProperty(exports, "reconcileOptimisticRows", {
  enumerable: true,
  get: function () {
    return _runtimePrimitives.reconcileOptimisticRows;
  }
});
Object.defineProperty(exports, "references", {
  enumerable: true,
  get: function () {
    return _relations.references;
  }
});
Object.defineProperty(exports, "registerReset", {
  enumerable: true,
  get: function () {
    return _reset.registerReset;
  }
});
Object.defineProperty(exports, "replayJournal", {
  enumerable: true,
  get: function () {
    return _configure.replayJournal;
  }
});
Object.defineProperty(exports, "resetRuntime", {
  enumerable: true,
  get: function () {
    return _reset.resetRuntime;
  }
});
Object.defineProperty(exports, "resolveStaleTempRows", {
  enumerable: true,
  get: function () {
    return _runtimePrimitives.resolveStaleTempRows;
  }
});
Object.defineProperty(exports, "scope", {
  enumerable: true,
  get: function () {
    return _scope.scope;
  }
});
Object.defineProperty(exports, "setDbTransport", {
  enumerable: true,
  get: function () {
    return _transport.setDbTransport;
  }
});
Object.defineProperty(exports, "stringifyNullish", {
  enumerable: true,
  get: function () {
    return _normalizeHelpers.stringifyNullish;
  }
});
Object.defineProperty(exports, "suspendDb", {
  enumerable: true,
  get: function () {
    return _lifecycle.suspendDb;
  }
});
Object.defineProperty(exports, "trimRowsPerScope", {
  enumerable: true,
  get: function () {
    return _runtimePrimitives.trimRowsPerScope;
  }
});
Object.defineProperty(exports, "waitForRow", {
  enumerable: true,
  get: function () {
    return _rowWaiters.waitForRow;
  }
});
var _configure = require("./dsl/configure.js");
var _transport = require("./core/transport.js");
var _lifecycle = require("./dsl/lifecycle.js");
var _DbProvider = require("./dsl/DbProvider.js");
var _reset = require("./core/reset.js");
var _storagePlane = require("./core/planes/storagePlane.js");
var _defineModel = require("./dsl/defineModel.js");
var _scope = require("./dsl/scope.js");
var _gc = require("./core/gc.js");
var _relations = require("./core/relations.js");
var _f = require("./schema/f.js");
var _shape = require("./schema/shape.js");
var _defineFetch = require("./dsl/defineFetch.js");
var _defineCommand = require("./dsl/defineCommand.js");
var _subscriptionRuntime = require("./core/subscriptionRuntime.js");
var _uniqueIds = require("./queries/base/uniqueIds.js");
var _generateTempId = require("./utils/generateTempId.js");
var _invariants = require("./core/invariants.js");
var _typeBoundary = require("./utils/typeBoundary.js");
var _normalizeHelpers = require("./utils/normalizeHelpers.js");
var _pickDefined = require("./utils/pickDefined.js");
var _mergeOptimisticSnapshot = require("./mutations/base/mergeOptimisticSnapshot.js");
var _optimisticMedia = require("./utils/optimisticMedia.js");
var _modelStatusPoller = require("./utils/modelStatusPoller.js");
var _runtimePrimitives = require("./utils/runtimePrimitives.js");
var _rowWaiters = require("./core/rowWaiters.js");
//# sourceMappingURL=index.js.map