"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.getSubscriptionEffect = exports.createSubscriptionEffects = void 0;
var _configure = require("../dsl/configure.js");
var _reset = require("./reset.js");
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
(0, _reset.registerReset)(resetSubscriptionRuntimeEffects);

/** Resolve an injected subscription effect by its stable application name. */
const getSubscriptionEffect = name => effectsRegistry.effects.get(name);

/** Create an injectable effects channel for subscription entries. */
exports.getSubscriptionEffect = getSubscriptionEffect;
const createSubscriptionEffects = noopEffects => {
  let activeEffects = noopEffects;
  const names = Object.keys(noopEffects);
  const generation = (0, _configure.getRuntimeGeneration)();
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
exports.createSubscriptionEffects = createSubscriptionEffects;
//# sourceMappingURL=subscriptionEffects.js.map