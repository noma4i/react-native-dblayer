import type { ModelFieldSpecs } from '../types';
type ModelScopeKeys = {
    keyForScope(scopeName: string, scopeValue: unknown): string;
    scopeValueFromRow(by: Record<string, string>, row: Record<string, unknown>): Record<string, unknown> | null;
};
export declare const createModelScopeKeys: (config: {
    name: string;
    fields: ModelFieldSpecs;
}, scopeByFieldMap: ReadonlyMap<string, Record<string, string>>) => ModelScopeKeys;
export {};
//# sourceMappingURL=modelScopeKeys.d.ts.map