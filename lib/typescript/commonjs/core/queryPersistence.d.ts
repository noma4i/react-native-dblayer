import type { QueryPersistenceDeclaration, QueryPersistenceRecord, QueryPersistenceWrite } from '../types';
export declare const readQueryPersistenceRevision: (declaration: QueryPersistenceDeclaration, identity: string) => number;
export declare const readPersistedQuery: <TPayload, TScope>(declaration: QueryPersistenceDeclaration, identity: string, validate: (record: QueryPersistenceRecord) => {
    payload: TPayload;
    scope: TScope;
}) => QueryPersistenceRecord<TPayload, TScope> | undefined;
export declare const readPersistedQueryFamily: (declaration: QueryPersistenceDeclaration) => QueryPersistenceRecord[];
export declare const writePersistedQuery: <TPayload, TScope>(input: QueryPersistenceWrite<TPayload, TScope>) => boolean;
export declare const invalidatePersistedQuery: (declaration: QueryPersistenceDeclaration, accepts: (record: QueryPersistenceRecord) => boolean) => QueryPersistenceRecord[];
export declare const removePersistedQuery: (declaration: QueryPersistenceDeclaration, identity?: string) => void;
//# sourceMappingURL=queryPersistence.d.ts.map