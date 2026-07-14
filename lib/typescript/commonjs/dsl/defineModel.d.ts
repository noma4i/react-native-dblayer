import type { DbReadOptions, DbWhere, ModelFieldSpecs } from '../types';
import type { JournalOp } from '../core/apply/journal';
import { type RelationDecl } from '../core/relations';
import type { Coverage, ScopeSpec } from './scope';
export type ScopeValueOf<TScope> = TScope extends ScopeSpec<infer _TStored> ? Record<string, unknown> : never;
export type ScopeHandle<TStored extends {
    id: string;
}, TScope> = {
    use(scopeValue: TScope | null | undefined): TStored[];
    useWindow(scopeValue: TScope | null | undefined, opts?: {
        pageSize?: number;
    }): {
        rows: TStored[];
        totalCount: number;
        hasMore: boolean;
        loadMore: () => void;
        refresh: () => Promise<void>;
    };
    useCount(scopeValue: TScope | null | undefined): number;
    invalidate(scopeValue?: TScope): void;
    read(scopeValue: TScope): TStored[];
    __apply?(scopeValue: TScope, rows: TStored[], coverage: Coverage): void;
    __planApply?(scopeValue: TScope, rows: Array<{
        row: TStored;
        edge?: Record<string, unknown>;
    }>, coverage: Coverage): JournalOp[];
};
type ModelCore<TStored extends {
    id: string;
    updatedAt?: string | null;
}> = {
    modelId: string;
    get(id: string | null | undefined): TStored | undefined;
    getWhere(where: DbWhere<TStored>, opts?: DbReadOptions<TStored>): TStored[];
    patch(id: string, patch: Partial<TStored>): void;
    destroy(id: string): void;
    destroyMany(ids: string[]): void;
    insertStored(row: TStored): void;
    replaceRaw(oldId: string, next: unknown): void;
    buildStored(input: unknown): TStored;
    normalize(input: unknown): Partial<TStored> & {
        id: string;
    };
    invalidate(scope?: unknown): void;
    gc(): number;
    use: {
        row(id: string | null | undefined, opts?: {
            select?: ReadonlyArray<keyof TStored>;
        }): TStored | undefined;
        field<K extends keyof TStored>(id: string | null | undefined, field: K): TStored[K] | undefined;
        first(where?: DbWhere<TStored> | null, opts?: DbReadOptions<TStored>): TStored | undefined;
        where(where: DbWhere<TStored> | null, opts?: DbReadOptions<TStored>): TStored[];
        byIds(ids: string[]): TStored[];
        count(where?: DbWhere<TStored> | null): number;
        related(id: string | null | undefined, relation: string): unknown;
    };
    scopes: Record<string, ScopeHandle<TStored, Record<string, unknown>>>;
    registerReset(fn: () => void): void;
    __applyRows?(rows: TStored[]): void;
    __planRows?(rows: TStored[]): JournalOp[];
    __planReplace?(oldId: string, next: unknown): JournalOp[];
};
type ModelConfig<TFields extends ModelFieldSpecs, TScopes extends Record<string, ScopeSpec<any>>, TExt extends Record<string, unknown>> = {
    id: string;
    name: string;
    fields: TFields;
    rowId?: (input: unknown) => string;
    guard?: (input: unknown) => boolean;
    relations?: () => Record<string, RelationDecl>;
    sideload?: unknown[];
    scopes?: TScopes;
    merge?: {
        shouldOverwrite?: (existing: unknown, incoming: unknown) => boolean;
        dedupeWindowMs?: number;
    };
    retention?: {
        orphanGc?: 'manual' | 'eager' | 'off';
        keep?: (row: unknown) => boolean;
    };
    statics?: (model: ModelCore<any>) => TExt;
};
/** Define a v6 model backed by EntityState and the shared journalled apply pipeline. */
export declare const defineModel: <TFields extends ModelFieldSpecs, TScopes extends Record<string, ScopeSpec<any>> = {}, TExt extends Record<string, unknown> = {}>(config: ModelConfig<TFields, TScopes, TExt>) => ModelCore<any> & {
    scopes: { [K in keyof TScopes]: ScopeHandle<any, ScopeValueOf<TScopes[K]>>; };
} & TExt;
export {};
//# sourceMappingURL=defineModel.d.ts.map