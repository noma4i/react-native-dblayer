import type { EntityState, ModelMembership, ModelRevisionOwner, ModelWrites } from '../types';
export declare const createModelWrites: <TStored extends {
    id: string;
} & Record<string, unknown>>(options: {
    modelId: string;
    modelName: string;
    entityState(): EntityState<TStored>;
    normalize(input: unknown): TStored;
    isPlanRow(input: unknown): boolean;
    revisions: ModelRevisionOwner<TStored>;
    captureMembership(id: string): ModelMembership[];
}) => ModelWrites<TStored>;
//# sourceMappingURL=modelWrites.d.ts.map