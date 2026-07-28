import type { MembershipDelta } from '../types';
type ModelMembership<TStored extends {
    id: string;
}> = {
    membershipForUpsert(before: TStored | undefined, after: Record<string, unknown>): MembershipDelta[];
    detachForDestroy(id: string): MembershipDelta[];
};
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
}) => ModelMembership<TStored>;
export {};
//# sourceMappingURL=modelMembership.d.ts.map