import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readCoreFile = (name: string): string => readFileSync(resolve(process.cwd(), 'src/core', name), 'utf8');
const lineCount = (source: string): number => source.split('\n').length;

describe('store module decomposition discipline', () => {
  it('keeps the store facade free of entity-plane and scope-plane definitions', () => {
    const source = readCoreFile('store.ts');
    expect(source).toContain("from './storeEntities'");
    expect(source).toContain("from './storeScopeCollections'");
    expect(source).not.toMatch(/const (?:previewUpsert|projectScopeChange|buildScopeCollection|prune)\b/);
  });

  it('keeps each store module below the decomposition target (spec 11 DC3)', () => {
    expect(lineCount(readCoreFile('store.ts'))).toBeLessThanOrEqual(350);
    expect(lineCount(readCoreFile('storeEntities.ts'))).toBeLessThanOrEqual(350);
    expect(lineCount(readCoreFile('storeScopeCollections.ts'))).toBeLessThanOrEqual(350);
    expect(lineCount(readCoreFile('storeSync.ts'))).toBeLessThanOrEqual(350);
    expect(lineCount(readCoreFile('storeUpsertResolver.ts'))).toBeLessThanOrEqual(350);
  });

  it('defines each store responsibility in exactly one module', () => {
    const sources = ['store.ts', 'storeEntities.ts', 'storeScopeCollections.ts', 'storeSync.ts', 'storeUpsertResolver.ts'].map(readCoreFile).join('\n');
    for (const name of ['createModelStore', 'createEntityPlane', 'createScopePlane', 'createUpsertResolver', 'runInApplyBatch', 'publishProjectedBatch']) {
      expect(sources.match(new RegExp(`(?:export )?const ${name}\\b`, 'g'))).toHaveLength(1);
    }
  });
});
