import type { RowRecord } from './db.types';
import type { ProjectionOptions } from './read.projectionGate.types';

/** How a scope orders its rows: authoritative server order, one stored field, or a comparator. */
export type ScopeSortMeta = { kind: 'server-order' } | { kind: 'field'; field: string; dir: 'asc' | 'desc' } | { kind: 'comparator' };

/** Scope read projection options plus scope-only flags: retention and required stored fields. */
export type ScopeProjectionOptions<TOutput extends Record<string, unknown>> = ProjectionOptions<RowRecord, TOutput> & { keepPrevious?: boolean; require?: ReadonlyArray<string> };

/** One window snapshot handed to scope window readers, with retention and resolution flags. */
export type ScopeWindowSnapshot = { rows: RowRecord[]; totalCount: number; isPreviousData: boolean; resolved: boolean };

/** Cached require-gate pass: the source rows it filtered and the gated result. */
export type RequireGate = { source: RowRecord[] | null; require: ReadonlyArray<string> | undefined; result: RowRecord[] };

/** Work counters for one scope read pass, split into full and incremental row costs. */
export type ScopeReadWorkSnapshot = { fullRows: number; incrementalRows: number };
