import type { ResultOf, TypedDocumentNode } from '@graphql-typed-document-node/core';
import { createSubscriptionEffects, getSubscriptionEffect } from './subscriptionEffects';
import { eraseTypedDbSubscriptionEntry } from './subscriptionEntry';
import { createSubscriptionLifecycle } from './subscriptionLifecycle';
import type {
  DbSubscriptionEffectsChannel,
  DbSubscriptionEntry,
  DbSubscriptionRuntime,
  TypedDbSubscriptionEntry
} from '../types';

/** Resolve an injected subscription effect by its stable application name. */
export const getDbSubscriptionEffect = (name: string): ((...args: unknown[]) => void) | undefined =>
  getSubscriptionEffect(name) as unknown as ((...args: unknown[]) => void) | undefined;

/**
 * Define a typed subscription entry for a heterogeneous runtime registry.
 *
 * @param entry Typed document, root-field key, variables, debounce, and payload handler.
 * @returns Runtime subscription entry accepted by `createDbSubscriptionRuntime`.
 */
export const defineDbSubscriptionEntry = <TDocument extends TypedDocumentNode<unknown, never>, TKey extends Extract<keyof ResultOf<TDocument>, string>>(
  entry: TypedDbSubscriptionEntry<TDocument, TKey>
): DbSubscriptionEntry<unknown> => eraseTypedDbSubscriptionEntry(entry);

/**
 * Create an injectable effects channel for subscription entries.
 *
 * @param noopEffects Complete effect table with no-op implementations.
 * @returns Stable effects table plus configure and reset controls.
 */
export const createDbSubscriptionEffects = <TEffects extends Record<keyof TEffects, (...args: never[]) => void>>(
  noopEffects: TEffects
): DbSubscriptionEffectsChannel<TEffects> => createSubscriptionEffects(noopEffects);

/**
 * Create a plain subscription runtime over the configured DB transport.
 *
 * @param entries Static subscription entries.
 * @returns Runtime controller for activation, dispatch, inspection, and teardown.
 */
export const createDbSubscriptionRuntime = <TPayload = unknown>(entries: readonly DbSubscriptionEntry<TPayload>[]): DbSubscriptionRuntime => createSubscriptionLifecycle(entries);
