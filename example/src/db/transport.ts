import { print } from 'graphql';
import { mmkvStoragePlane, type DbTransport } from '@noma4i/react-native-dblayer';

export const GRAPHQL_ENDPOINT = 'https://graphqlplaceholder.vercel.app/graphql';
// Fallback endpoint: https://graphqlzero.almansi.me/api

const request = async <TData>(document: unknown, variables: Record<string, unknown> = {}): Promise<{ data: TData }> => {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: print(document as never), variables }),
  });
  const payload = await response.json() as { data?: TData; errors?: Array<{ message: string }> };
  if (!response.ok || payload.errors?.length) throw new Error(payload.errors?.map(error => error.message).join(', ') ?? `GraphQL HTTP ${response.status}`);
  if (payload.data === undefined) throw new Error('GraphQL response did not include data');
  return { data: payload.data };
};

export const exampleTransport: DbTransport = {
  query: ({ query, variables }) => request(query, variables as Record<string, unknown>),
  mutation: ({ mutation, variables }) => request(mutation, variables as Record<string, unknown>),
  subscribe: () => {
    throw new Error('Subscriptions are unsupported by the public example endpoint');
  },
};

export const exampleStorage = mmkvStoragePlane();
