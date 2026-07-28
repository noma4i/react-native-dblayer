import type { DbSubscriptionEntry, TypedDbSubscriptionEntry } from '../types';
import type { ResultOf, TypedDocumentNode } from '@graphql-typed-document-node/core';

/** Erase a typed subscription entry at the heterogeneous runtime registry boundary. */
export const eraseTypedDbSubscriptionEntry = <TDocument extends TypedDocumentNode<unknown, never>, TKey extends Extract<keyof ResultOf<TDocument>, string>>(
  entry: TypedDbSubscriptionEntry<TDocument, TKey>
): DbSubscriptionEntry => entry as DbSubscriptionEntry;
