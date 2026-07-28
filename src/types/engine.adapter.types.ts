import type { ChangeMessage } from '@tanstack/db';

/** One engine entity row mirrored into the reactive store. */
export type EngineEntityRow = { id: string } & Record<string, unknown>;

/** One scope membership row mirrored into the reactive store. */
export type EngineMembershipRow = { scopeKey: string; entityId: string; orderKey: string };

export type EngineEntityChange = { type: 'upsert'; value: EngineEntityRow } | { type: 'delete'; id: string };

export type EngineMembershipChange = { type: 'upsert'; value: EngineMembershipRow } | { type: 'delete'; scopeKey: string; entityId: string };

export type EngineScopeRow = { id?: string; orderKey: string };

export type EngineScopeChange = ChangeMessage<EngineScopeRow, string | number>;

export type EngineScopeCollection = {
  toArray(): EngineScopeRow[];
  subscribe(listener: (changes: EngineScopeChange[]) => void): () => void;
};

export type EnginePlan = {
  entities: readonly EngineEntityChange[];
  memberships: readonly EngineMembershipChange[];
  membershipWriteKind?: 'delta' | 'rebuild';
  scopeOrder?: readonly string[];
};

export type EngineAdapter = {
  apply(plan: EnginePlan): void;
  markReady(): void;
  readEntity(id: string): EngineEntityRow | undefined;
  readScope(scopeKey: string): string[];
  scopeCollection(scopeKey: string): EngineScopeCollection;
  replaceScope(scopeKey: string, entityIds: readonly string[]): void;
  dispose(): void;
};
