"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useEntitiesById = exports.pickEqual = exports.buildStableItems = void 0;
exports.useJoinedEntities = useJoinedEntities;
exports.useStableArray = exports.useOrderedEntities = void 0;
exports.useStableEntity = useStableEntity;
exports.useStableItems = useStableItems;
exports.useStableSorted = void 0;
var _esToolkit = require("es-toolkit");
var _react = require("react");
var _normalizeHelpers = require("../../utils/normalizeHelpers.js");
var _mapById = require("./mapById.js");
const EMPTY = Object.freeze([]);
/** Build stable projected items by reusing unchanged cached entries. */
const buildStableItems = (sources, config, previousCache) => {
  if (!sources.length) {
    return {
      items: config.emptyItems,
      cache: new Map()
    };
  }
  const cache = new Map();
  const items = [];
  for (const source of sources) {
    const nextEntry = config.buildEntry(source);
    if (!nextEntry) continue;
    const key = config.getKey(source);
    const previousEntry = previousCache.get(key);
    if (previousEntry && config.entriesEqual(previousEntry, nextEntry)) {
      cache.set(key, previousEntry);
      items.push(previousEntry.item);
    } else {
      cache.set(key, nextEntry);
      items.push(nextEntry.item);
    }
  }
  return {
    items,
    cache
  };
};
exports.buildStableItems = buildStableItems;
const sameItems = (left, right) => left.length === right.length && left.every((item, index) => item === right[index]);

/**
 * Shared value-equality: reuse a prior view object when its rendered fields are unchanged. `useLiveQuery`
 * emits new object refs for unchanged rows, so identity-only reuse fails broadly and re-renders the whole
 * list/thread/feed; deep-comparing the listed fields keeps the view object's identity stable so memoized
 * rows skip re-rendering. One helper for chat list, chat thread AND feed - add a rendered field to the key
 * array to track it.
 */
const pickEqual = (prev, next, keys) => {
  if (prev == null || next == null) {
    return prev === next;
  }
  return (0, _esToolkit.isEqual)((0, _esToolkit.pick)(prev, keys), (0, _esToolkit.pick)(next, keys));
};
exports.pickEqual = pickEqual;
const defaultStableGetKey = source => {
  const id = source.id;
  if (typeof id !== 'string') {
    throw new Error('useStableItems default getKey requires source items with a string id.');
  }
  return id;
};
const defaultStableBuildEntry = source => ({
  item: source
});
const resolveStableItemsConfig = config => {
  if ('entriesEqual' in config && typeof config.entriesEqual === 'function') {
    return {
      getKey: config.getKey ?? defaultStableGetKey,
      buildEntry: config.buildEntry ?? defaultStableBuildEntry,
      emptyItems: config.emptyItems ?? EMPTY,
      entriesEqual: config.entriesEqual
    };
  }
  return {
    getKey: config.getKey ?? defaultStableGetKey,
    buildEntry: config.buildEntry ?? defaultStableBuildEntry,
    emptyItems: config.emptyItems ?? EMPTY,
    entriesEqual: (prev, next) => pickEqual(prev.item, next.item, config.renderKeys)
  };
};

/** React hook wrapper around `buildStableItems` with cache ownership and array identity reuse. */
function useStableItems(sources, config) {
  const cacheRef = (0, _react.useRef)(new Map());
  const itemsRef = (0, _react.useRef)(null);
  return (0, _react.useMemo)(() => {
    const stableConfig = resolveStableItemsConfig(config);
    const built = buildStableItems(sources, stableConfig, cacheRef.current);
    cacheRef.current = built.cache;
    const nextItems = built.items.length > 0 ? built.items : stableConfig.emptyItems;
    const previousItems = itemsRef.current;
    if (previousItems && sameItems(previousItems, nextItems)) {
      return previousItems;
    }
    itemsRef.current = nextItems;
    return nextItems;
  }, [sources, config]);
}
const stableEntityEqual = (prev, next, config) => {
  if ('renderKeys' in config) {
    return pickEqual(prev, next, config.renderKeys);
  }
  return (0, _esToolkit.isEqual)((0, _esToolkit.omit)(prev, config.volatileKeys), (0, _esToolkit.omit)(next, config.volatileKeys));
};

/** React hook that reuses one entity reference while configured fields remain equal. */
function useStableEntity(value, config) {
  const stableRef = (0, _react.useRef)(value);
  const previous = stableRef.current;
  if (value == null) {
    stableRef.current = value;
    return value;
  }
  if (previous != null && stableEntityEqual(previous, value, config)) {
    return previous;
  }
  stableRef.current = value;
  return value;
}

/** React hook that reuses an array instance when its element references did not change. */
const useStableArray = next => {
  const stableRef = (0, _react.useRef)(null);
  const previous = stableRef.current;
  if (previous && sameItems(previous, next)) {
    return previous;
  }
  stableRef.current = next;
  return next;
};

/** React hook that memoizes sorted output and reuses it for element-identical input arrays. */
exports.useStableArray = useStableArray;
const useStableSorted = (source, compare, invalidationKey) => {
  const sortRef = (0, _react.useRef)(null);
  return (0, _react.useMemo)(() => {
    const previous = sortRef.current;
    if (previous && Object.is(previous.invalidationKey, invalidationKey) && sameItems(previous.source, source)) {
      return previous.output;
    }
    const output = source.length > 0 ? [...source].sort(compare) : [];
    sortRef.current = {
      source,
      invalidationKey,
      output
    };
    return output;
  }, [source, compare, invalidationKey]);
};

/** React hook that reads rows by id and returns them keyed by id. */
exports.useStableSorted = useStableSorted;
const useEntitiesById = (model, ids) => (0, _mapById.useMapById)(model.byIds(ids));

/** React hook that reads entities by id and returns rows in the input id order, dropping missing ids. */
exports.useEntitiesById = useEntitiesById;
const useOrderedEntities = (model, ids) => {
  const byId = useEntitiesById(model, ids);
  return (0, _react.useMemo)(() => {
    if (ids.length === 0) return EMPTY;
    const ordered = [];
    for (const id of ids) {
      const item = byId.get(id);
      if (item) ordered.push(item);
    }
    return ordered.length > 0 ? ordered : EMPTY;
  }, [byId, ids]);
};
exports.useOrderedEntities = useOrderedEntities;
const readJoinEntityId = (join, idField) => {
  if (!join || typeof join !== 'object') return undefined;
  return (0, _normalizeHelpers.readId)(join[idField]);
};

/**
 * React hook that hydrates join rows into entity rows while preserving join-row order.
 *
 * Missing entity ids are dropped, matching `useOrderedEntities`. The optional `map` callback must be
 * pure; its result participates in the same `useStableItems` render-key stability contract as manual
 * `useOrderedEntities` plus `useStableItems` pipelines.
 *
 * @param joinRows Join rows whose `idField` stores the entity id. Nullish and empty inputs return the shared stable empty array.
 * @param config Entity id field, model read surface, optional render keys, and optional pure join/entity projection.
 * @returns Stable hydrated entities, or mapped items when `map` is provided.
 */

function useJoinedEntities(joinRows, config) {
  const pairs = (0, _react.useMemo)(() => {
    if (!joinRows?.length) return EMPTY;
    const nextPairs = [];
    for (const join of joinRows) {
      const id = readJoinEntityId(join, config.idField);
      if (id) {
        nextPairs.push({
          id,
          join
        });
      }
    }
    return nextPairs.length > 0 ? nextPairs : EMPTY;
  }, [joinRows, config.idField]);
  const ids = (0, _react.useMemo)(() => {
    if (pairs.length === 0) return EMPTY;
    return pairs.map(pair => pair.id);
  }, [pairs]);
  const orderedEntities = useOrderedEntities(config.model, ids);
  const sources = (0, _react.useMemo)(() => {
    if (pairs.length === 0 || orderedEntities.length === 0) return EMPTY;
    const entitiesById = new Map();
    for (const entity of orderedEntities) {
      const bucket = entitiesById.get(entity.id);
      if (bucket) {
        bucket.push(entity);
      } else {
        entitiesById.set(entity.id, [entity]);
      }
    }
    const nextSources = [];
    for (const pair of pairs) {
      const bucket = entitiesById.get(pair.id);
      const entity = bucket?.shift();
      if (entity) {
        nextSources.push({
          id: pair.id,
          join: pair.join,
          entity
        });
      }
    }
    return nextSources.length > 0 ? nextSources : EMPTY;
  }, [orderedEntities, pairs]);
  const stableConfig = (0, _react.useMemo)(() => {
    const baseConfig = {
      getKey: source => source.id,
      buildEntry: source => ({
        item: config.map ? config.map(source.join, source.entity) : source.entity
      }),
      emptyItems: EMPTY
    };
    if (config.renderKeys) {
      return {
        ...baseConfig,
        renderKeys: config.renderKeys
      };
    }
    return {
      ...baseConfig,
      entriesEqual: (prev, next) => Object.is(prev.item, next.item)
    };
  }, [config.map, config.renderKeys]);
  return useStableItems(sources, stableConfig);
}
//# sourceMappingURL=shared.js.map