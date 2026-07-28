import type { EntityState } from './core.planes.entityState.types';
import type { RelationDecl } from './core.relations.types';
import type { ScopeIndex } from './core.planes.scopeIndex.types';

export type ModelContext<TStored extends { id: string }> = {
  planes(): { entityState: EntityState<TStored>; scopeIndex: ScopeIndex };
  resolvedRelations(): Record<string, RelationDecl>;
  revision(): number;
  bumpRevision(): void;
  issuedScopeSequence(key: string): number | undefined;
  setIssuedScopeSequence(key: string, value: number): void;
  model<TModel>(): TModel;
  setModel(model: unknown): void;
  reset(): void;
};
