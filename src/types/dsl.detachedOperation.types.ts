export type DetachedOperationConfig<TInput, TStored extends { id: string }> = {
  build: (input: TInput, ctx: { tempId: string }) => Omit<TStored, 'id'> | TStored;
  resume: (entry: { operationId: string; tempId: string; input: TInput }) => Promise<'continue' | 'orphaned'>;
  failure?: 'rollback' | 'keep';
  onFailurePatch?: (input: TInput) => Partial<TStored>;
};

export type DetachedOperationHandle<TInput> = {
  start(input: TInput): { operationId: string; tempId: string };
  complete(operationId: string, serverNode: unknown): void;
  fail(operationId: string, error: Error): void;
  retry(operationId: string): Promise<'continue' | 'orphaned' | null>;
  discard(operationId: string): void;
};
