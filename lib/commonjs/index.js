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
Object.defineProperty(exports, "buildStableItems", {
  enumerable: true,
  get: function () {
    return _shared.buildStableItems;
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
Object.defineProperty(exports, "clearAllCollections", {
  enumerable: true,
  get: function () {
    return _registry.clearAllCollections;
  }
});
Object.defineProperty(exports, "clearDbStorage", {
  enumerable: true,
  get: function () {
    return _mmkvStorage.clearDbStorage;
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
Object.defineProperty(exports, "computePhase", {
  enumerable: true,
  get: function () {
    return _loadingState.computePhase;
  }
});
Object.defineProperty(exports, "configureDb", {
  enumerable: true,
  get: function () {
    return _configure.configureDb;
  }
});
Object.defineProperty(exports, "createCollectionBinding", {
  enumerable: true,
  get: function () {
    return _shared.createCollectionBinding;
  }
});
Object.defineProperty(exports, "createDbSubscriptionRuntime", {
  enumerable: true,
  get: function () {
    return _subscriptionRuntime.createDbSubscriptionRuntime;
  }
});
Object.defineProperty(exports, "createExtractSink", {
  enumerable: true,
  get: function () {
    return _extract.createExtractSink;
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
Object.defineProperty(exports, "createMutationExtractResolver", {
  enumerable: true,
  get: function () {
    return _extract.createMutationExtractResolver;
  }
});
Object.defineProperty(exports, "createNestedObjectPatcher", {
  enumerable: true,
  get: function () {
    return _runtimePrimitives.createNestedObjectPatcher;
  }
});
Object.defineProperty(exports, "createOptimisticSequence", {
  enumerable: true,
  get: function () {
    return _generateTempId.createOptimisticSequence;
  }
});
Object.defineProperty(exports, "createThrottledSingleFlight", {
  enumerable: true,
  get: function () {
    return _runtimePrimitives.createThrottledSingleFlight;
  }
});
Object.defineProperty(exports, "createTombstoneLedger", {
  enumerable: true,
  get: function () {
    return _runtimePrimitives.createTombstoneLedger;
  }
});
Object.defineProperty(exports, "createUniqueIds", {
  enumerable: true,
  get: function () {
    return _uniqueIds.createUniqueIds;
  }
});
Object.defineProperty(exports, "defineModel", {
  enumerable: true,
  get: function () {
    return _createPersistentCollection.defineModel;
  }
});
Object.defineProperty(exports, "defineShape", {
  enumerable: true,
  get: function () {
    return _shape.defineShape;
  }
});
Object.defineProperty(exports, "devClearAllDataAndState", {
  enumerable: true,
  get: function () {
    return _registry.devClearAllDataAndState;
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
Object.defineProperty(exports, "getDbStorageKeys", {
  enumerable: true,
  get: function () {
    return _mmkvStorage.getDbStorageKeys;
  }
});
Object.defineProperty(exports, "hasMany", {
  enumerable: true,
  get: function () {
    return _relations.hasMany;
  }
});
Object.defineProperty(exports, "hasManyThrough", {
  enumerable: true,
  get: function () {
    return _relations.hasManyThrough;
  }
});
Object.defineProperty(exports, "hasOne", {
  enumerable: true,
  get: function () {
    return _relations.hasOne;
  }
});
Object.defineProperty(exports, "invalidateDbRequests", {
  enumerable: true,
  get: function () {
    return _queryClient.invalidateDbRequests;
  }
});
Object.defineProperty(exports, "invalidateModel", {
  enumerable: true,
  get: function () {
    return _queryClient.invalidateModel;
  }
});
Object.defineProperty(exports, "isTempId", {
  enumerable: true,
  get: function () {
    return _generateTempId.isTempId;
  }
});
Object.defineProperty(exports, "liftExtractNodes", {
  enumerable: true,
  get: function () {
    return _extract.liftExtractNodes;
  }
});
Object.defineProperty(exports, "mergeInitialSyncContract", {
  enumerable: true,
  get: function () {
    return _requestRuntime.mergeInitialSyncContract;
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
Object.defineProperty(exports, "mergeSyncContract", {
  enumerable: true,
  get: function () {
    return _serverSync.mergeSyncContract;
  }
});
Object.defineProperty(exports, "mmkvStorageAdapter", {
  enumerable: true,
  get: function () {
    return _mmkvStorage.mmkvStorageAdapter;
  }
});
Object.defineProperty(exports, "mmkvStorageEventApi", {
  enumerable: true,
  get: function () {
    return _mmkvStorage.mmkvStorageEventApi;
  }
});
Object.defineProperty(exports, "modelDetailRequest", {
  enumerable: true,
  get: function () {
    return _modelDetailRequest.modelDetailRequest;
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
Object.defineProperty(exports, "pruneExpiredRows", {
  enumerable: true,
  get: function () {
    return _runtimePrimitives.pruneExpiredRows;
  }
});
Object.defineProperty(exports, "pruneOrphanedRows", {
  enumerable: true,
  get: function () {
    return _runtimePrimitives.pruneOrphanedRows;
  }
});
Object.defineProperty(exports, "pruneStaleFetchStates", {
  enumerable: true,
  get: function () {
    return _freshnessStorage.pruneStaleFetchStates;
  }
});
Object.defineProperty(exports, "readFieldsPatch", {
  enumerable: true,
  get: function () {
    return _shape.readFieldsPatch;
  }
});
Object.defineProperty(exports, "readId", {
  enumerable: true,
  get: function () {
    return _normalizeHelpers.readId;
  }
});
Object.defineProperty(exports, "readNullableNumber", {
  enumerable: true,
  get: function () {
    return _normalizeHelpers.readNullableNumber;
  }
});
Object.defineProperty(exports, "readNullableString", {
  enumerable: true,
  get: function () {
    return _normalizeHelpers.readNullableString;
  }
});
Object.defineProperty(exports, "readNumber", {
  enumerable: true,
  get: function () {
    return _normalizeHelpers.readNumber;
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
Object.defineProperty(exports, "removeDbStorageKey", {
  enumerable: true,
  get: function () {
    return _mmkvStorage.removeDbStorageKey;
  }
});
Object.defineProperty(exports, "replaceInitialSyncContract", {
  enumerable: true,
  get: function () {
    return _requestRuntime.replaceInitialSyncContract;
  }
});
Object.defineProperty(exports, "replaceSyncContract", {
  enumerable: true,
  get: function () {
    return _serverSync.replaceSyncContract;
  }
});
Object.defineProperty(exports, "resetAllModelsState", {
  enumerable: true,
  get: function () {
    return _registry.resetAllModelsState;
  }
});
Object.defineProperty(exports, "resetDbQueryRuntime", {
  enumerable: true,
  get: function () {
    return _queryClient.resetDbQueryRuntime;
  }
});
Object.defineProperty(exports, "resolveStaleTempRows", {
  enumerable: true,
  get: function () {
    return _runtimePrimitives.resolveStaleTempRows;
  }
});
Object.defineProperty(exports, "runDbCommandDirect", {
  enumerable: true,
  get: function () {
    return _useCommand.runDbCommandDirect;
  }
});
Object.defineProperty(exports, "runDbInfiniteQueryDirect", {
  enumerable: true,
  get: function () {
    return _requestRuntime.runDbInfiniteQueryDirect;
  }
});
Object.defineProperty(exports, "runDbMutationDirect", {
  enumerable: true,
  get: function () {
    return _executeDbMutation.runDbMutationDirect;
  }
});
Object.defineProperty(exports, "runDbQueryDirect", {
  enumerable: true,
  get: function () {
    return _requestRuntime.runDbQueryDirect;
  }
});
Object.defineProperty(exports, "singletonStatics", {
  enumerable: true,
  get: function () {
    return _runtimePrimitives.singletonStatics;
  }
});
Object.defineProperty(exports, "stableSerialize", {
  enumerable: true,
  get: function () {
    return _serialize.stableSerialize;
  }
});
Object.defineProperty(exports, "toRequiredStr", {
  enumerable: true,
  get: function () {
    return _normalizeHelpers.toRequiredStr;
  }
});
Object.defineProperty(exports, "toStr", {
  enumerable: true,
  get: function () {
    return _normalizeHelpers.toStr;
  }
});
Object.defineProperty(exports, "trimRowsPerScope", {
  enumerable: true,
  get: function () {
    return _runtimePrimitives.trimRowsPerScope;
  }
});
Object.defineProperty(exports, "useCommand", {
  enumerable: true,
  get: function () {
    return _useCommand.useCommand;
  }
});
Object.defineProperty(exports, "useDbInfiniteRequest", {
  enumerable: true,
  get: function () {
    return _useDbRequest.useDbInfiniteRequest;
  }
});
Object.defineProperty(exports, "useDbMutation", {
  enumerable: true,
  get: function () {
    return _useDbMutation.useDbMutation;
  }
});
Object.defineProperty(exports, "useDbSingleRequest", {
  enumerable: true,
  get: function () {
    return _useDbRequest.useDbSingleRequest;
  }
});
Object.defineProperty(exports, "useEntitiesById", {
  enumerable: true,
  get: function () {
    return _shared.useEntitiesById;
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
Object.defineProperty(exports, "useStableItems", {
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
Object.defineProperty(exports, "useWindowedLoadMore", {
  enumerable: true,
  get: function () {
    return _shared.useWindowedLoadMore;
  }
});
Object.defineProperty(exports, "waitForRow", {
  enumerable: true,
  get: function () {
    return _rowWaiters.waitForRow;
  }
});
var _configure = require("./configure.js");
var _createPersistentCollection = require("./core/createPersistentCollection.js");
var _relations = require("./core/relations.js");
var _loadingState = require("./queries/base/loadingState.js");
var _freshnessStorage = require("./core/freshnessStorage.js");
var _registry = require("./core/registry.js");
var _serialize = require("./core/serialize.js");
var _extract = require("./core/extract.js");
var _queryClient = require("./core/queryClient.js");
var _subscriptionRuntime = require("./core/subscriptionRuntime.js");
var _rowWaiters = require("./core/rowWaiters.js");
var _f = require("./schema/f.js");
var _schema = require("./schema/schema.js");
var _shape = require("./schema/shape.js");
var _executeDbMutation = require("./mutations/base/executeDbMutation.js");
var _mergeOptimisticSnapshot = require("./mutations/base/mergeOptimisticSnapshot.js");
var _useCommand = require("./mutations/base/useCommand.js");
var _useDbMutation = require("./mutations/base/useDbMutation.js");
var _requestRuntime = require("./queries/base/requestRuntime.js");
var _modelDetailRequest = require("./queries/base/modelDetailRequest.js");
var _shared = require("./queries/base/shared.js");
var _uniqueIds = require("./queries/base/uniqueIds.js");
var _useDbRequest = require("./queries/base/useDbRequest.js");
var _generateTempId = require("./utils/generateTempId.js");
var _modelStatusPoller = require("./utils/modelStatusPoller.js");
var _mmkvStorage = require("./utils/mmkvStorage.js");
var _pickDefined = require("./utils/pickDefined.js");
var _normalizeHelpers = require("./utils/normalizeHelpers.js");
var _serverSync = require("./utils/serverSync.js");
var _optimisticMedia = require("./utils/optimisticMedia.js");
var _typeBoundary = require("./utils/typeBoundary.js");
var _runtimePrimitives = require("./utils/runtimePrimitives.js");
//# sourceMappingURL=index.js.map