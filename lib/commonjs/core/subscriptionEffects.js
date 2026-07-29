"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.getSubscriptionEffect = exports.createSubscriptionEffects = void 0;
var _generationRegistry = require("./generationRegistry.js");
/**
 * Definition registry: effect channels are created once at app-module load and outlive
 * `resetRuntime`, so the registry survives the kill-switch. Same-generation duplicate names still
 * throw; a later-generation registration replaces the previous one.
 */
const effectsRegistry = (0, _generationRegistry.createGenerationRegistry)();

/** Resolve an injected subscription effect by its stable application name. */
const getSubscriptionEffect = name => effectsRegistry.get(name);

/** Create an injectable effects channel for subscription entries. */
exports.getSubscriptionEffect = getSubscriptionEffect;
const createSubscriptionEffects = noopEffects => {
  let activeEffects = noopEffects;
  const names = Object.keys(noopEffects);
  for (const name of names) {
    effectsRegistry.assertCanRegister(name, `subscription effect already registered: ${name}`);
  }
  const effects = {};
  for (const name of names) {
    const key = name;
    const effect = (...args) => {
      activeEffects[key](...args);
    };
    effects[key] = effect;
  }
  const unregisterEffects = Object.entries(effects).map(([name, effect]) => effectsRegistry.register(name, effect, `subscription effect already registered: ${name}`));
  const unregisterNames = () => {
    for (const unregister of unregisterEffects) unregister();
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