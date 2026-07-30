"use strict";

const removeSingletonId = input => {
  const {
    id: _ignoredId,
    ...updates
  } = input;
  return updates;
};

/**
 * Build statics for a single-row model with defaults and clamped numeric updates.
 *
 * @param model Model that owns the singleton row.
 * @param recordId Stable singleton row id.
 * @param defaults Default row returned before insertion and used for first upsert.
 * @returns Singleton statics for reading, upserting, and clamped numeric patches.
 */
export const createSingletonStatics = (model, recordId, defaults) => {
  const upsert = input => {
    const updates = removeSingletonId(input);
    const existing = model.find(recordId);
    if (existing) {
      model.update(recordId, updates);
      return;
    }
    model.insert({
      ...defaults,
      ...updates,
      id: recordId
    });
  };
  return {
    recordId,
    defaults,
    current: () => model.find(recordId),
    useCurrent: () => model.useFind(recordId) ?? defaults,
    /** Reactive read of ONE singleton field with a field-level dependency: consumers re-render only when this field changes, unlike useCurrent which subscribes to the whole row. */
    useCurrentField: field => model.useFind(recordId, {
      renderKeys: [field]
    })?.[field] ?? defaults[field],
    upsertCurrent: upsert,
    updateClamped: (field, delta, min = 0) => {
      if (delta === 0) return false;
      const current = model.find(recordId);
      if (!current) return false;
      const value = current[field];
      const currentValue = typeof value === 'number' ? value : 0;
      model.update(recordId, {
        [field]: Math.max(min, currentValue + delta)
      });
      return true;
    }
  };
};
//# sourceMappingURL=singletonStatics.js.map