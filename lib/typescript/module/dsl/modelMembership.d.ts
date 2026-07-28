import type { ModelMembershipPlanner } from '../types';
export declare const createModelMembership: <TStored extends {
    id: string;
}>(options: {
    membershipScopes: ReadonlyArray<readonly [string, {
        by: Record<string, string>;
        member?: (row: TStored) => boolean;
    }]>;
    keyForScope(scopeName: string, scopeValue: unknown): string;
    scopeValueFromRow(by: Record<string, string>, row: Record<string, unknown>): Record<string, unknown> | null;
    isScopeMember(scopeKey: string, id: string): boolean;
    scopeKeysOf(id: string): string[];
}) => ModelMembershipPlanner<TStored>;
//# sourceMappingURL=modelMembership.d.ts.map