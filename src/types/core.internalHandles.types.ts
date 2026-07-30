import type { WriteOp } from './core.apply.journal.types';
import type { RelationDecl } from './core.relations.types';
import type { ScopeCoverage } from './core.planes.scopeIndex.types';
import type { RowRecord } from './db.types';

/** Opaque per-model capabilities exposed to query/mutation seams without widening the public model type. */
export type InternalModelHandle = {
  readRow(id: string): RowRecord | undefined;
  applyRows(rows: unknown[]): void;
  applyPatch(id: string, patch: Record<string, unknown>, operationId?: string): void;
  planRows(rows: unknown[], options?: { origin?: 'event' }): WriteOp[];
  planReplace(oldId: string, next: unknown): WriteOp[];
  captureMembership(id: string): Array<{ id: string; scopeKey: string; orderKey: string }>;
  planRestore(next: unknown, memberships: Array<{ id: string; scopeKey: string; orderKey: string }>): WriteOp[];
  relations(): Record<string, RelationDecl>;
  revision(): number;
  dropTempRowsAfterMs(): number | undefined;
};

/** Opaque per-scope capabilities: apply plans, keying, order semantics, and resolution. */
export type InternalScopeHandle = {
  apply(scopeValue: unknown, rows: unknown[], coverage: ScopeCoverage, options?: { resetOrder?: boolean }): void;
  planApply(scopeValue: unknown, rows: Array<{ row: unknown }>, coverage: ScopeCoverage, options?: { resetOrder?: boolean }): WriteOp[];
  key(scopeValue: unknown): string;
  isServerOrder(): boolean;
  planPlacement(scopeValue: unknown, id: string, position: 'prepend' | 'append'): WriteOp[];
  readRows(scopeValue: unknown): RowRecord[];
  isResolved(scopeValue: unknown): boolean;
  noteAccess(scopeValue: unknown): void;
};
