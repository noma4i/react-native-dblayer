import type { DbTransport } from '../../types';

export const mockTransport = (handlers: Partial<DbTransport>): DbTransport => ({
  query: handlers.query ?? (async <TData,>() => ({ data: {} as TData })),
  mutation: handlers.mutation ?? (async <TData,>() => ({ data: {} as TData }))
});
