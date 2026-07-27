type RowId = { id: string };

type PatchModel<TStored extends RowId> = {
  find(id: string): TStored | undefined;
  update(id: string, updates: Partial<TStored>): boolean | void;
};

type SingletonModel<TStored extends RowId> = PatchModel<TStored> & {
  insert(item: TStored): void;
  use: {
    find(id: string | null | undefined): TStored | undefined;
    field<TField extends keyof TStored & string>(id: string | null | undefined, field: TField): TStored[TField] | undefined;
  };
};

type NumericField<TStored> = {
  [K in keyof TStored]: TStored[K] extends number ? K : never;
}[keyof TStored];

const removeSingletonId = <TStored extends RowId>(input: Partial<TStored>): Omit<Partial<TStored>, 'id'> => {
  const { id: _ignoredId, ...updates } = input;
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
export const createSingletonStatics = <TStored extends RowId>(model: SingletonModel<TStored>, recordId: string, defaults: TStored) => {
  const upsert = (input: Partial<TStored>): void => {
    const updates = removeSingletonId(input);
    const existing = model.find(recordId);
    if (existing) {
      model.update(recordId, updates as Partial<TStored>);
      return;
    }

    model.insert({ ...defaults, ...updates, id: recordId } as TStored);
  };

  return {
    recordId,
    defaults,
    current: (): TStored | undefined => model.find(recordId),
    useCurrent: (): TStored => model.use.find(recordId) ?? defaults,
    /** Reactive read of ONE singleton field with a field-level dependency: consumers re-render only when this field changes, unlike useCurrent which subscribes to the whole row. */
    useCurrentField: <TField extends keyof TStored & string>(field: TField): TStored[TField] => (model.use.field(recordId, field) ?? defaults[field]) as TStored[TField],
    upsertCurrent: upsert,
    updateClamped: <TField extends Extract<NumericField<TStored>, string>>(field: TField, delta: number, min = 0): boolean => {
      if (delta === 0) return false;
      const current = model.find(recordId);
      if (!current) return false;

      const value = current[field];
      const currentValue = typeof value === 'number' ? value : 0;
      model.update(recordId, { [field]: Math.max(min, currentValue + delta) } as Partial<TStored>);
      return true;
    }
  };
};
