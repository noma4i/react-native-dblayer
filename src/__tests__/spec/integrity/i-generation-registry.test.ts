import { createGenerationRegistry } from '../../../core/generationRegistry';

describe('generation registry', () => {
  it('rejects a duplicate registration in the same runtime generation', () => {
    const registry = createGenerationRegistry<object>(() => 1);
    registry.register('owner', {}, 'duplicate owner');
    expect(() => registry.register('owner', {}, 'duplicate owner')).toThrow('duplicate owner');
  });

  it('allows a stale registration to be replaced after reset', () => {
    let generation = 1;
    const registry = createGenerationRegistry<object>(() => generation);
    const replacement = {};
    registry.register('owner', {}, 'duplicate owner');
    generation += 1;
    expect(() => registry.register('owner', replacement, 'duplicate owner')).not.toThrow();
    expect(registry.get('owner')).toBe(replacement);
  });

  it('keeps the replacement when a stale disposer runs', () => {
    let generation = 1;
    const registry = createGenerationRegistry<object>(() => generation);
    const unregisterStale = registry.register('owner', {}, 'duplicate owner');
    const replacement = {};
    generation += 1;
    registry.register('owner', replacement, 'duplicate owner');
    unregisterStale();
    expect(registry.get('owner')).toBe(replacement);
  });
});
