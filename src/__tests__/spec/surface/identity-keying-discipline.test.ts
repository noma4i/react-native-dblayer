import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve(__dirname, '../../../read/scopeReadEngine.ts'), 'utf8');
const liveReadSource = fs.readFileSync(path.resolve(__dirname, '../../../read/useLiveRead.ts'), 'utf8');
const incrementalReadSource = fs.readFileSync(path.resolve(__dirname, '../../../read/incrementalReadEngine.ts'), 'utf8');
const storeSource = fs.readFileSync(path.resolve(__dirname, '../../../core/store.ts'), 'utf8');
const scopeIndexSource = fs.readFileSync(path.resolve(__dirname, '../../../core/planes/scopeIndex.ts'), 'utf8');
const configureSource = fs.readFileSync(path.resolve(__dirname, '../../../dsl/configure.ts'), 'utf8');

describe('identity keying discipline', () => {
  it('keeps each scope entry and resolved row in one record instead of parallel arrays', () => {
    expect(source).not.toMatch(/\brows\s*\[\s*currentIndex\s*\]/);
  });

  it('routes dependency signatures through the canonical composite-key builder', () => {
    expect(liveReadSource).not.toContain(".join('|')");
    expect(liveReadSource).not.toContain("dep.fields?.join(',')");
  });

  it('routes incremental signatures through the canonical composite-key builder', () => {
    expect(incrementalReadSource).not.toMatch(/values\.map\(semanticValue\)\.join\(['\"]:['\"]\)/);
  });

  it('encodes persisted row and scope segments without delimiter parsing', () => {
    expect(storeSource).not.toContain('row:${modelId}:${id}');
    expect(scopeIndexSource).not.toContain('scope:${modelId}:${key}');
    expect(configureSource).not.toContain("split(':', 2)");
  });
});
