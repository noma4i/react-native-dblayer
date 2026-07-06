"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
Object.defineProperty(exports, "DEFAULT_FETCH_STATE_MAX_AGE_MS", {
  enumerable: true,
  get: function () {
    return _freshnessStorage.DEFAULT_FETCH_STATE_MAX_AGE_MS;
  }
});
Object.defineProperty(exports, "EMPTY_IDS", {
  enumerable: true,
  get: function () {
    return _uniqueIds.EMPTY_IDS;
  }
});
Object.defineProperty(exports, "acceptPersistentCollectionMutations", {
  enumerable: true,
  get: function () {
    return _registry.acceptPersistentCollectionMutations;
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
Object.defineProperty(exports, "clearAllFreshnessMetadata", {
  enumerable: true,
  get: function () {
    return _freshnessStorage.clearAllFreshnessMetadata;
  }
});
Object.defineProperty(exports, "clearCollectionFetchState", {
  enumerable: true,
  get: function () {
    return _freshnessStorage.clearCollectionFetchState;
  }
});
Object.defineProperty(exports, "clearCollectionFetchStates", {
  enumerable: true,
  get: function () {
    return _freshnessStorage.clearCollectionFetchStates;
  }
});
Object.defineProperty(exports, "clearDbStorage", {
  enumerable: true,
  get: function () {
    return _mmkvStorage.clearDbStorage;
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
Object.defineProperty(exports, "createCollectionBinding", {
  enumerable: true,
  get: function () {
    return _shared.createCollectionBinding;
  }
});
Object.defineProperty(exports, "createCollectionModel", {
  enumerable: true,
  get: function () {
    return _createCollectionModel.createCollectionModel;
  }
});
Object.defineProperty(exports, "createMerge", {
  enumerable: true,
  get: function () {
    return _createMerge.createMerge;
  }
});
Object.defineProperty(exports, "createPatchCrud", {
  enumerable: true,
  get: function () {
    return _createPatchCrud.createPatchCrud;
  }
});
Object.defineProperty(exports, "createPersistentCollection", {
  enumerable: true,
  get: function () {
    return _createPersistentCollection.createPersistentCollection;
  }
});
Object.defineProperty(exports, "createReplace", {
  enumerable: true,
  get: function () {
    return _createReplace.createReplace;
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
Object.defineProperty(exports, "deriveDbKey", {
  enumerable: true,
  get: function () {
    return _deriveDbKey.deriveDbKey;
  }
});
Object.defineProperty(exports, "devClearAllDataAndState", {
  enumerable: true,
  get: function () {
    return _registry.devClearAllDataAndState;
  }
});
Object.defineProperty(exports, "executeDbInfiniteRequest", {
  enumerable: true,
  get: function () {
    return _requestRuntime.executeDbInfiniteRequest;
  }
});
Object.defineProperty(exports, "executeDbSingleRequest", {
  enumerable: true,
  get: function () {
    return _requestRuntime.executeDbSingleRequest;
  }
});
Object.defineProperty(exports, "generateTempId", {
  enumerable: true,
  get: function () {
    return _generateTempId.generateTempId;
  }
});
Object.defineProperty(exports, "getCollectionFetchState", {
  enumerable: true,
  get: function () {
    return _freshnessStorage.getCollectionFetchState;
  }
});
Object.defineProperty(exports, "getDbExtractSink", {
  enumerable: true,
  get: function () {
    return _extract.getDbExtractSink;
  }
});
Object.defineProperty(exports, "getDbLogger", {
  enumerable: true,
  get: function () {
    return _logger.getDbLogger;
  }
});
Object.defineProperty(exports, "getDbMutationExtractResolver", {
  enumerable: true,
  get: function () {
    return _extract.getDbMutationExtractResolver;
  }
});
Object.defineProperty(exports, "getDbQueryClient", {
  enumerable: true,
  get: function () {
    return _queryClient.getDbQueryClient;
  }
});
Object.defineProperty(exports, "getDbStorageAdapter", {
  enumerable: true,
  get: function () {
    return _storage.getDbStorageAdapter;
  }
});
Object.defineProperty(exports, "getDbStorageKeys", {
  enumerable: true,
  get: function () {
    return _mmkvStorage.getDbStorageKeys;
  }
});
Object.defineProperty(exports, "getDbTransport", {
  enumerable: true,
  get: function () {
    return _transport.getDbTransport;
  }
});
Object.defineProperty(exports, "instance", {
  enumerable: true,
  get: function () {
    return _index.instance;
  }
});
Object.defineProperty(exports, "invalidateDbRequests", {
  enumerable: true,
  get: function () {
    return _queryClient.invalidateDbRequests;
  }
});
Object.defineProperty(exports, "isInManagedMutationBatch", {
  enumerable: true,
  get: function () {
    return _registry.isInManagedMutationBatch;
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
Object.defineProperty(exports, "mergeSyncContract", {
  enumerable: true,
  get: function () {
    return _serverSync.mergeSyncContract;
  }
});
Object.defineProperty(exports, "mmkvCollectionOptions", {
  enumerable: true,
  get: function () {
    return _mmkvCollectionOptions.mmkvCollectionOptions;
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
Object.defineProperty(exports, "pickEqual", {
  enumerable: true,
  get: function () {
    return _shared.pickEqual;
  }
});
Object.defineProperty(exports, "pruneStaleFetchStates", {
  enumerable: true,
  get: function () {
    return _freshnessStorage.pruneStaleFetchStates;
  }
});
Object.defineProperty(exports, "query", {
  enumerable: true,
  get: function () {
    return _index.query;
  }
});
Object.defineProperty(exports, "readBoolean", {
  enumerable: true,
  get: function () {
    return _normalizeHelpers.readBoolean;
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
Object.defineProperty(exports, "readString", {
  enumerable: true,
  get: function () {
    return _normalizeHelpers.readString;
  }
});
Object.defineProperty(exports, "refetchDbRequests", {
  enumerable: true,
  get: function () {
    return _queryClient.refetchDbRequests;
  }
});
Object.defineProperty(exports, "registerCollectionFetchStateCache", {
  enumerable: true,
  get: function () {
    return _freshnessStorage.registerCollectionFetchStateCache;
  }
});
Object.defineProperty(exports, "registerModelRuntimeReset", {
  enumerable: true,
  get: function () {
    return _registry.registerModelRuntimeReset;
  }
});
Object.defineProperty(exports, "registerPersistentCollectionMutationAcceptor", {
  enumerable: true,
  get: function () {
    return _registry.registerPersistentCollectionMutationAcceptor;
  }
});
Object.defineProperty(exports, "removeDbStorageKey", {
  enumerable: true,
  get: function () {
    return _mmkvStorage.removeDbStorageKey;
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
Object.defineProperty(exports, "runDbMutationDirect", {
  enumerable: true,
  get: function () {
    return _executeDbMutation.runDbMutationDirect;
  }
});
Object.defineProperty(exports, "runInManagedMutationBatch", {
  enumerable: true,
  get: function () {
    return _registry.runInManagedMutationBatch;
  }
});
Object.defineProperty(exports, "setCollectionFetchState", {
  enumerable: true,
  get: function () {
    return _freshnessStorage.setCollectionFetchState;
  }
});
Object.defineProperty(exports, "setDbExtractSink", {
  enumerable: true,
  get: function () {
    return _extract.setDbExtractSink;
  }
});
Object.defineProperty(exports, "setDbLogger", {
  enumerable: true,
  get: function () {
    return _logger.setDbLogger;
  }
});
Object.defineProperty(exports, "setDbMutationExtractResolver", {
  enumerable: true,
  get: function () {
    return _extract.setDbMutationExtractResolver;
  }
});
Object.defineProperty(exports, "setDbStorageAdapter", {
  enumerable: true,
  get: function () {
    return _storage.setDbStorageAdapter;
  }
});
Object.defineProperty(exports, "setDbTransport", {
  enumerable: true,
  get: function () {
    return _transport.setDbTransport;
  }
});
Object.defineProperty(exports, "shallowEqual", {
  enumerable: true,
  get: function () {
    return _invariants.shallowEqual;
  }
});
Object.defineProperty(exports, "shouldAcceptIncoming", {
  enumerable: true,
  get: function () {
    return _invariants.shouldAcceptIncoming;
  }
});
Object.defineProperty(exports, "stableSerialize", {
  enumerable: true,
  get: function () {
    return _serialize.stableSerialize;
  }
});
Object.defineProperty(exports, "toQueryValue", {
  enumerable: true,
  get: function () {
    return _typeBoundary.toQueryValue;
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
Object.defineProperty(exports, "useCollectionRead", {
  enumerable: true,
  get: function () {
    return _shared.useCollectionRead;
  }
});
Object.defineProperty(exports, "useCommand", {
  enumerable: true,
  get: function () {
    return _useCommand.useCommand;
  }
});
Object.defineProperty(exports, "useCommandMutation", {
  enumerable: true,
  get: function () {
    return _useCommandMutation.useCommandMutation;
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
Object.defineProperty(exports, "useInstance", {
  enumerable: true,
  get: function () {
    return _index.useInstance;
  }
});
var _createCollectionModel = require("./core/createCollectionModel.js");
var _configure = require("./configure.js");
var _index = require("./activeRecord/index.js");
var _createMerge = require("./core/createMerge.js");
var _deriveDbKey = require("./core/deriveDbKey.js");
var _createPatchCrud = require("./core/createPatchCrud.js");
var _createPersistentCollection = require("./core/createPersistentCollection.js");
var _createReplace = require("./core/createReplace.js");
var _loadingState = require("./queries/base/loadingState.js");
var _freshnessStorage = require("./core/freshnessStorage.js");
var _invariants = require("./core/invariants.js");
var _mmkvCollectionOptions = require("./core/mmkvCollectionOptions.js");
var _registry = require("./core/registry.js");
var _serialize = require("./core/serialize.js");
var _extract = require("./core/extract.js");
var _logger = require("./core/logger.js");
var _queryClient = require("./core/queryClient.js");
var _storage = require("./core/storage.js");
var _transport = require("./core/transport.js");
var _executeDbMutation = require("./mutations/base/executeDbMutation.js");
var _useCommand = require("./mutations/base/useCommand.js");
var _useCommandMutation = require("./mutations/base/useCommandMutation.js");
var _useDbMutation = require("./mutations/base/useDbMutation.js");
var _requestRuntime = require("./queries/base/requestRuntime.js");
var _shared = require("./queries/base/shared.js");
var _uniqueIds = require("./queries/base/uniqueIds.js");
var _useDbRequest = require("./queries/base/useDbRequest.js");
var _generateTempId = require("./utils/generateTempId.js");
var _mmkvStorage = require("./utils/mmkvStorage.js");
var _normalizeHelpers = require("./utils/normalizeHelpers.js");
var _serverSync = require("./utils/serverSync.js");
var _typeBoundary = require("./utils/typeBoundary.js");
//# sourceMappingURL=index.js.map