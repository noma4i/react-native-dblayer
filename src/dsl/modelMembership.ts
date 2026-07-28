import type { MembershipDelta } from '../types';

type ModelMembership<TStored extends { id: string }> = {
  membershipForUpsert(before: TStored | undefined, after: Record<string, unknown>): MembershipDelta[];
  detachForDestroy(id: string): MembershipDelta[];
};

export const createModelMembership = <TStored extends { id: string }>(options: {
  membershipScopes: ReadonlyArray<readonly [string, { by: Record<string, string>; member?: (row: TStored) => boolean }] >;
  keyForScope(scopeName: string, scopeValue: unknown): string;
  scopeValueFromRow(by: Record<string, string>, row: Record<string, unknown>): Record<string, unknown> | null;
  isScopeMember(scopeKey: string, id: string): boolean;
  scopeKeysOf(id: string): string[];
}): ModelMembership<TStored> => {
  const membershipForUpsert = (before: TStored | undefined, after: Record<string, unknown>): MembershipDelta[] => {
    const id = String(after.id);
    const deltas: MembershipDelta[] = [];
    for (const [scopeName, spec] of options.membershipScopes) {
      const beforeValue = before && (spec.member?.(before) ?? true) ? options.scopeValueFromRow(spec.by, before) : null;
      const afterValue = (spec.member?.(after as TStored) ?? true) ? options.scopeValueFromRow(spec.by, after) : null;
      const beforeKey = beforeValue ? options.keyForScope(scopeName, beforeValue) : null;
      const afterKey = afterValue ? options.keyForScope(scopeName, afterValue) : null;
      if (beforeKey && beforeKey !== afterKey && options.isScopeMember(beforeKey, id)) deltas.push({ scopeKey: beforeKey, detach: [id] });
      if (afterKey && !options.isScopeMember(afterKey, id)) deltas.push({ scopeKey: afterKey, append: [id] });
    }
    return deltas;
  };
  return {
    membershipForUpsert,
    detachForDestroy: (id: string): MembershipDelta[] => options.scopeKeysOf(id).map(scopeKey => ({ scopeKey, detach: [id] }))
  };
};
