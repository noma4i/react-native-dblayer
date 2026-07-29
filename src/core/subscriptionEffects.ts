import type { DbSubscriptionEffectsChannel } from '../types';
import { createGenerationRegistry } from './generationRegistry';

/**
 * Definition registry: effect channels are created once at app-module load and outlive
 * `resetRuntime`, so the registry survives the kill-switch. Same-generation duplicate names still
 * throw; a later-generation registration replaces the previous one.
 */
const effectsRegistry = createGenerationRegistry<(...args: never[]) => void>();

/** Resolve an injected subscription effect by its stable application name. */
export const getSubscriptionEffect = (name: string): ((...args: never[]) => void) | undefined => effectsRegistry.get(name);

/** Create an injectable effects channel for subscription entries. */
export const createSubscriptionEffects = <TEffects extends Record<keyof TEffects, (...args: never[]) => void>>(
  noopEffects: TEffects
): DbSubscriptionEffectsChannel<TEffects> => {
  let activeEffects: TEffects = noopEffects;
  const names = Object.keys(noopEffects);
  for (const name of names) {
    effectsRegistry.assertCanRegister(name, `subscription effect already registered: ${name}`);
  }

  const effects = {} as TEffects;
  for (const name of names) {
    const key = name as keyof TEffects;
    const effect = (...args: never[]): void => {
      activeEffects[key](...args);
    };
    effects[key] = effect as TEffects[keyof TEffects];
  }
  const unregisterEffects = Object.entries(effects).map(([name, effect]) =>
    effectsRegistry.register(name, effect as (...args: never[]) => void, `subscription effect already registered: ${name}`)
  );
  const unregisterNames = (): void => {
    for (const unregister of unregisterEffects) unregister();
  };

  return {
    effects,
    configure: overrides => {
      activeEffects = { ...noopEffects, ...overrides } as TEffects;
    },
    reset: () => {
      activeEffects = noopEffects;
      unregisterNames();
    }
  };
};
