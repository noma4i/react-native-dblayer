import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readApplyFile = (name: string): string => readFileSync(resolve(process.cwd(), 'src/core/apply', name), 'utf8');
const lineCount = (source: string): number => source.split('\n').length;

describe('apply module decomposition discipline', () => {
  it('keeps the durable transaction runtime free of registry, planning, and execution definitions', () => {
    const source = readApplyFile('transaction.ts');
    expect(source).toContain("from './applyTargetRegistry'");
    expect(source).toContain("from './applyExecution'");
    expect(source).not.toMatch(/const (?:targets|compileWritePlan|applyAtomically)\b/);
  });

  it('keeps each extracted logic owner below the decomposition target', () => {
    expect(lineCount(readApplyFile('applyTargetRegistry.ts'))).toBeLessThanOrEqual(80);
    expect(lineCount(readApplyFile('commitEnvelope.ts'))).toBeLessThanOrEqual(260);
    expect(lineCount(readApplyFile('applyExecution.ts'))).toBeLessThanOrEqual(140);
    expect(lineCount(readApplyFile('transaction.ts'))).toBeLessThanOrEqual(180);
  });

  it('defines each apply responsibility in exactly one module', () => {
    const sources = ['applyTargetRegistry.ts', 'commitEnvelope.ts', 'applyExecution.ts', 'transaction.ts'].map(readApplyFile).join('\n');
    for (const name of ['registerApplyTarget', 'createCommitEnvelope', 'applyAtomically', 'createApplyRuntime']) {
      expect(sources.match(new RegExp(`(?:export )?const ${name}\\b`, 'g'))).toHaveLength(1);
    }
  });
});
