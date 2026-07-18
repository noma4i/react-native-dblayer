import type { CommitBus } from '../apply/commitBus';
/** Starts synchronously mirroring every commit-bus row batch into TanStack model collections. */
export declare function startCollectionMirror(bus: CommitBus): () => void;
/** Seeds model collections from their visible EntityState rows after hydration. */
export declare function seedCollections(models: string[]): void;
//# sourceMappingURL=mirror.d.ts.map