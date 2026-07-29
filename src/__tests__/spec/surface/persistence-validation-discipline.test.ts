import fs from 'node:fs';
import path from 'node:path';

const sourceRoot = path.resolve(__dirname, '../../..');
const journalSource = fs.readFileSync(path.join(sourceRoot, 'core/apply/journal.ts'), 'utf8');
const commitEnvelopeSource = fs.readFileSync(path.join(sourceRoot, 'core/apply/commitEnvelope.ts'), 'utf8');

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== '__tests__') return sourceFiles(target);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [target] : [];
  });

const declarationSites = (name: string): string[] =>
  sourceFiles(sourceRoot).filter(file => {
    const source = fs.readFileSync(file, 'utf8');
    return new RegExp(`(?:const|function)\\s+${name}\\b`).test(source);
  });

describe('persistence validation discipline', () => {
  it('keeps scope-entry and scope-snapshot validation in the scope-index owner', () => {
    expect(declarationSites('deduplicateScopeEntriesById').map(file => path.relative(sourceRoot, file))).toEqual(['core/planes/scopeIndex.ts']);
    expect(declarationSites('isScopeEntry').map(file => path.relative(sourceRoot, file))).toEqual(['core/planes/scopeIndex.ts']);
    expect(declarationSites('isScopeEntrySet').map(file => path.relative(sourceRoot, file))).toEqual(['core/planes/scopeIndex.ts']);
    expect(declarationSites('isScopeIndexValue').map(file => path.relative(sourceRoot, file))).toEqual(['core/planes/scopeIndex.ts']);
  });

  it('reuses scope-owned recursive validators at the WAL boundary', () => {
    expect(journalSource).toContain("import { isScopeEntrySet, isScopeIndexValue } from '../planes/scopeIndex'");
    expect(journalSource).toContain("if (op.kind === 'scope') return isNonEmptyString(op.scopeKey) && isScopeIndexValue(op.next)");
    expect(journalSource).toContain('isScopeEntrySet(op.append)');
  });

  it('canonicalizes live scope deltas before the commit envelope reaches WAL', () => {
    expect(commitEnvelopeSource).toContain("import { deduplicateScopeEntriesById } from '../planes/scopeIndex'");
    expect(commitEnvelopeSource).toContain('const append = deduplicateScopeEntriesById(op.append)');
  });
});
