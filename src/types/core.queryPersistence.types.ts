export type QueryPersistenceRecord<TPayload = unknown, TScope = unknown> = {
  recordVersion: 1;
  family: string;
  identity: string;
  persistenceVersion: number;
  fingerprint: string;
  scope: TScope;
  payload: TPayload;
  empty: boolean;
  dataUpdatedAt: number;
  invalidated: boolean;
};

export type QueryPersistenceDeclaration = {
  family: string;
  persistenceVersion: number;
  fingerprint: string;
};

export type QueryPersistenceWrite<TPayload, TScope> = QueryPersistenceDeclaration & {
  identity: string;
  scope: TScope;
  payload: TPayload;
  empty: boolean;
  dataUpdatedAt: number;
  invalidated?: boolean;
};
