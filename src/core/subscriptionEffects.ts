import { getRuntimeGeneration } from '../dsl/configure';
import { registerReset } from './reset';
import type { DbSubscriptionEffectsChannel } from '../types';

type SubscriptionEffectsRegistry = {
  effects: Map<string, (...args: never[]) => void>;
  generations: Map<string, number>;
};

const createSubscriptionEffectsRegistry = (): SubscriptionEffectsRegistry => ({ effects: new Map(), generations: new Map() });

const effectsRegistry = createSubscriptionEffectsRegistry();

/** Clear injected effect wrappers during runtime teardown. */
const resetSubscriptionRuntimeEffects = (): void => {
  effectsRegistry.effects.clear();
  effectsRegistry.generations.clear();
};

registerReset(resetSubscriptionRuntimeEffects);

/** Resolve an injected subscription effect by its stable application name. */
export const getSubscriptionEffect = (name: string): ((...args: never[]) => void) | undefined => effectsRegistry.effects.get(name);

/** Create an injectable effects channel for subscription entries. */
export const createSubscriptionEffects = <TEffects extends Record<keyof TEffects, (...args: never[]) => void>>(
  noopEffects: TEffects
): DbSubscriptionEffectsChannel<TEffects> => {
  let activeEffects: TEffects = noopEffects;
  const names = Object.keys(noopEffects);
  const generation = getRuntimeGeneration();
  for (const name of names) {
    if (effectsRegistry.effects.has(name) && effectsRegistry.generations.get(name) === generation) throw new Error(`subscription effect already registered: ${name}`);
  }

  const effects = {} as TEffects;
  for (const name of names) {
    const key = name as keyof TEffects;
    const effect = (...args: never[]): void => {
      activeEffects[key](...args);
    };
    effects[key] = effect as TEffects[keyof TEffects];
  }
  for (const [name, effect] of Object.entries(effects)) {
    effectsRegistry.effects.set(name, effect as (...args: never[]) => void);
    effectsRegistry.generations.set(name, generation);
  }
  const unregisterNames = (): void => {
    for (const name of names) {
      const effect = effects[name as keyof TEffects] as (...args: never[]) => void;
      if (effectsRegistry.effects.get(name) !== effect) continue;
      effectsRegistry.effects.delete(name);
      effectsRegistry.generations.delete(name);
    }
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
