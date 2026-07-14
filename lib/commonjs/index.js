"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
Object.defineProperty(exports, "EMPTY_IDS", {
  enumerable: true,
  get: function () {
    return _uniqueIds.EMPTY_IDS;
  }
});
Object.defineProperty(exports, "belongsTo", {
  enumerable: true,
  get: function () {
    return _relations.belongsTo;
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
Object.defineProperty(exports, "compositeId", {
  enumerable: true,
  get: function () {
    return _schema.compositeId;
  }
});
Object.defineProperty(exports, "computeLoadingState", {
  enumerable: true,
  get: function () {
    return _loadingState.computeLoadingState;
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
Object.defineProperty(exports, "createKeyedArrayPatcher", {
  enumerable: true,
  get: function () {
    return _runtimePrimitives.createKeyedArrayPatcher;
  }
});
Object.defineProperty(exports, "createKeyedBatchBuffer", {
  enumerable: true,
  get: function () {
    return _runtimePrimitives.createKeyedBatchBuffer;
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
Object.defineProperty(exports, "createThrottledSingleFlight", {
  enumerable: true,
  get: function () {
    return _runtimePrimitives.createThrottledSingleFlight;
  }
});
Object.defineProperty(exports, "createUniqueIds", {
  enumerable: true,
  get: function () {
    return _uniqueIds.createUniqueIds;
  }
});
Object.defineProperty(exports, "defineDbSubscriptionEntry", {
  enumerable: true,
  get: function () {
    return _subscriptionRuntime.defineDbSubscriptionEntry;
  }
});
Object.defineProperty(exports, "defineIngest", {
  enumerable: true,
  get: function () {
    return _defineIngest.defineIngest;
  }
});
Object.defineProperty(exports, "defineModel", {
  enumerable: true,
  get: function () {
    return _defineModel.defineModel;
  }
});
Object.defineProperty(exports, "defineMutation", {
  enumerable: true,
  get: function () {
    return _defineMutation.defineMutation;
  }
});
Object.defineProperty(exports, "defineQuery", {
  enumerable: true,
  get: function () {
    return _defineQuery.defineQuery;
  }
});
Object.defineProperty(exports, "defineShape", {
  enumerable: true,
  get: function () {
    return _shape.defineShape;
  }
});
Object.defineProperty(exports, "f", {
  enumerable: true,
  get: function () {
    return _f.f;
  }
});
Object.defineProperty(exports, "generateTempId", {
  enumerable: true,
  get: function () {
    return _generateTempId.generateTempId;
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
Object.defineProperty(exports, "patchWhenPresent", {
  enumerable: true,
  get: function () {
    return _rowWaiters.patchWhenPresent;
  }
});
Object.defineProperty(exports, "pickDefined", {
  enumerable: true,
  get: function () {
    return _pickDefined.pickDefined;
  }
});
Object.defineProperty(exports, "pickEqual", {
  enumerable: true,
  get: function () {
    return _shared.pickEqual;
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
Object.defineProperty(exports, "readFieldsPatch", {
  enumerable: true,
  get: function () {
    return _shape.readFieldsPatch;
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
Object.defineProperty(exports, "resetRuntime", {
  enumerable: true,
  get: function () {
    return _reset.resetRuntime;
  }
});
Object.defineProperty(exports, "scope", {
  enumerable: true,
  get: function () {
    return _scope.scope;
  }
});
Object.defineProperty(exports, "setAccountPartition", {
  enumerable: true,
  get: function () {
    return _configure.setAccountPartition;
  }
});
Object.defineProperty(exports, "singletonStatics", {
  enumerable: true,
  get: function () {
    return _runtimePrimitives.singletonStatics;
  }
});
Object.defineProperty(exports, "toStr", {
  enumerable: true,
  get: function () {
    return _normalizeHelpers.toStr;
  }
});
Object.defineProperty(exports, "useJoinedEntities", {
  enumerable: true,
  get: function () {
    return _shared.useJoinedEntities;
  }
});
Object.defineProperty(exports, "useOrderedEntities", {
  enumerable: true,
  get: function () {
    return _shared.useOrderedEntities;
  }
});
Object.defineProperty(exports, "useStableEntity", {
  enumerable: true,
  get: function () {
    return _shared.useStableEntity;
  }
});
Object.defineProperty(exports, "useStableProjection", {
  enumerable: true,
  get: function () {
    return _shared.useStableItems;
  }
});
Object.defineProperty(exports, "useStableSorted", {
  enumerable: true,
  get: function () {
    return _shared.useStableSorted;
  }
});
Object.defineProperty(exports, "waitForRow", {
  enumerable: true,
  get: function () {
    return _rowWaiters.waitForRow;
  }
});
var _configure = require("./dsl/configure.js");
var _reset = require("./core/reset.js");
var _storagePlane = require("./core/planes/storagePlane.js");
var _defineModel = require("./dsl/defineModel.js");
var _scope = require("./dsl/scope.js");
var _relations = require("./core/relations.js");
var _schema = require("./schema/schema.js");
var _f = require("./schema/f.js");
var _shape = require("./schema/shape.js");
var _defineQuery = require("./dsl/defineQuery.js");
var _defineMutation = require("./dsl/defineMutation.js");
var _defineIngest = require("./dsl/defineIngest.js");
var _subscriptionRuntime = require("./core/subscriptionRuntime.js");
var _shared = require("./queries/base/shared.js");
var _uniqueIds = require("./queries/base/uniqueIds.js");
var _loadingState = require("./queries/base/loadingState.js");
var _generateTempId = require("./utils/generateTempId.js");
var _typeBoundary = require("./utils/typeBoundary.js");
var _normalizeHelpers = require("./utils/normalizeHelpers.js");
var _pickDefined = require("./utils/pickDefined.js");
var _mergeOptimisticSnapshot = require("./mutations/base/mergeOptimisticSnapshot.js");
var _optimisticMedia = require("./utils/optimisticMedia.js");
var _modelStatusPoller = require("./utils/modelStatusPoller.js");
var _runtimePrimitives = require("./utils/runtimePrimitives.js");
var _rowWaiters = require("./core/rowWaiters.js");
//# sourceMappingURL=index.js.map