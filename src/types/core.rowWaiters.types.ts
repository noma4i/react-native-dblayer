/** Minimal model surface the row waiters read and patch through. */
export type WaiterModel<TStored extends { id: string }> = {
  find(id: string | null | undefined): TStored | undefined;
  update(id: string, patch: Record<string, unknown>): void;
} & ({ modelId: string } | { key: string });

export type RowPatch<TStored> = Partial<TStored> | ((row: TStored) => Partial<TStored>);

export type UpdateWhenRowExistsOptions = {
  /** Maximum time to keep a deferred patch before dropping it. */
  ttlMs: number;
};

export type WaitForRowOptions = {
  /** Maximum time to wait before resolving with `undefined`. */
  timeoutMs: number;
  /** Optional abort signal that resolves the waiter with `undefined` and cleans up immediately. */
  signal?: AbortSignal;
};
