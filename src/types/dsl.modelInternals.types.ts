import type { DbWhere } from './db.types';
import type { MembershipDelta } from './core.relations.types';

/** Internal membership calculator: scope deltas for one upsert or destroy. */
export type ModelMembershipPlanner<TStored extends { id: string }> = {
  membershipForUpsert(before: TStored | undefined, after: Record<string, unknown>): MembershipDelta[];
  detachForDestroy(id: string): MembershipDelta[];
};

/** Internal scope-key derivation for one model's declared scopes. */
export type ModelScopeKeys = {
  keyForScope(scopeName: string, scopeValue: unknown): string;
  normalizeScopeValue(scopeName: string, scopeValue: unknown): unknown;
  isScopeValueComplete(scopeName: string, scopeValue: unknown): boolean;
  scopeValueFromRow(by: Record<string, string>, row: Record<string, unknown>): Record<string, unknown> | null;
};

/** Internal `DbWhere` matcher compiled per model. */
export type ModelCriteria<TRow extends Record<string, unknown>> = { matches(row: TRow, where: DbWhere<TRow>): boolean };
