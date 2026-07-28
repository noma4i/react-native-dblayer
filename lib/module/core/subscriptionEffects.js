"use strict";

import { getRuntimeGeneration } from "../dsl/configure.js";
import { registerReset } from "./reset.js";
const createSubscriptionEffectsRegistry = () => ({
  effects: new Map(),
  generations: new Map()
});
const effectsRegistry = createSubscriptionEffectsRegistry();

/** Clear injected effect wrappers during runtime teardown. */
const resetSubscriptionRuntimeEffects = () => {
  effectsRegistry.effects.clear();
  effectsRegistry.generations.clear();
};
registerReset(resetSubscriptionRuntimeEffects);

/** Resolve an injected subscription effect by its stable application name. */
export const getSubscriptionEffect = name => effectsRegistry.effects.get(name);

/** Create an injectable effects channel for subscription entries. */
export const createSubscriptionEffects = noopEffects => {
  let activeEffects = noopEffects;
  const names = Object.keys(noopEffects);
  const generation = getRuntimeGeneration();
  for (const name of names) {
    if (effectsRegistry.effects.has(name) && effectsRegistry.generations.get(name) === generation) throw new Error(`subscription effect already registered: ${name}`);
  }
  const effects = {};
  for (const name of names) {
    const key = name;
    const effect = (...args) => {
      activeEffects[key](...args);
    };
    effects[key] = effect;
  }
  for (const [name, effect] of Object.entries(effects)) {
    effectsRegistry.effects.set(name, effect);
    effectsRegistry.generations.set(name, generation);
  }
  const unregisterNames = () => {
    for (const name of names) {
      const effect = effects[name];
      if (effectsRegistry.effects.get(name) !== effect) continue;
      effectsRegistry.effects.delete(name);
      effectsRegistry.generations.delete(name);
    }
  };
  return {
    effects,
    configure: overrides => {
      activeEffects = {
        ...noopEffects,
        ...overrides
      };
    },
    reset: () => {
      activeEffects = noopEffects;
      unregisterNames();
    }
  };
};
//# sourceMappingURL=subscriptionEffects.js.map