import type { ModelMirrorConfig, StoredRowBase } from '../types';
type RuntimeStoredRow = StoredRowBase & Record<string, unknown>;
type RuntimeMirrorConfig = ModelMirrorConfig<RuntimeStoredRow, RuntimeStoredRow>;
export declare const createMirrorPropagator: (sourceName: string, mirrors: RuntimeMirrorConfig[] | undefined) => ((row: RuntimeStoredRow) => void) | null;
export {};
//# sourceMappingURL=modelMirror.d.ts.map