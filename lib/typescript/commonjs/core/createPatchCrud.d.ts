import type { CreatePatchCrudConfig, PatchCrud } from '../types';
/** Create patch and destroy helpers for a collection. */
export declare function createPatchCrud<T extends {
    id: string;
    updatedAt?: string | null;
}>(config: CreatePatchCrudConfig<T>): PatchCrud<T>;
//# sourceMappingURL=createPatchCrud.d.ts.map