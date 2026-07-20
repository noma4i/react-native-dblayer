import type { JournalOp } from './apply/journal';
import type { RelationDecl } from './relations';
import type { ScopeCoverage } from './planes/scopeIndex';

export type InternalModelHandle = {
  readRow(id: string): { id: string; [key: string]: unknown } | undefined;
  applyRows(rows: unknown[]): void;
  planRows(rows: unknown[], options?: { includeMembership?: boolean; origin?: 'event' }): JournalOp[];
  planReplace(oldId: string, next: unknown): JournalOp[];
  captureMembership(id: string): Array<{ id: string; scopeKey: string; order: number; edge?: Record<string, unknown> }>;
  planRestore(next: unknown, memberships: Array<{ id: string; scopeKey: string; order: number; edge?: Record<string, unknown> }>): JournalOp[];
  relations(): Record<string, RelationDecl>;
  revision(): number;
};

export type InternalScopeHandle = {
  apply(scopeValue: unknown, rows: unknown[], coverage: ScopeCoverage, options?: { resetOrder?: boolean }): void;
  planApply(scopeValue: unknown, rows: Array<{ row: unknown; edge?: Record<string, unknown> }>, coverage: ScopeCoverage, options?: { resetOrder?: boolean }): JournalOp[];
  key(scopeValue: unknown): string;
  isServerOrder(): boolean;
  planPlacement(scopeValue: unknown, id: string, position: 'prepend' | 'append'): JournalOp[];
  readRows(scopeValue: unknown): Array<{ id: string; [key: string]: unknown }>;
  isResolved(scopeValue: unknown): boolean;
  noteAccess(scopeValue: unknown): void;
};

const modelHandles = new WeakMap<object, InternalModelHandle>();
const scopeHandles = new WeakMap<object, InternalScopeHandle>();

export const registerInternalModelHandle = (model: object, handle: InternalModelHandle): void => {
  modelHandles.set(model, handle);
};

export const registerInternalScopeHandle = (scope: object, handle: InternalScopeHandle): void => {
  scopeHandles.set(scope, handle);
};

export const getInternalModelHandle = (model: object): InternalModelHandle => {
  const handle = modelHandles.get(model);
  if (!handle) throw new Error('Unknown model handle');
  return handle;
};

export const getInternalScopeHandle = (scope: object): InternalScopeHandle => {
  const handle = scopeHandles.get(scope);
  if (!handle) throw new Error('Unknown scope handle');
  return handle;
};

export const hasInternalScopeHandle = (scope: object): boolean => scopeHandles.has(scope);
