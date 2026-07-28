import fs from 'node:fs';
import path from 'node:path';
import * as barrel from '../../../index';

const root = path.resolve(__dirname, '../../../..');
const docsDir = path.join(root, 'docs');

const listMarkdownFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listMarkdownFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.md') ? [entryPath] : [];
  });

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const exportReferenceRows = (): Array<{ name: string; kind: 'value' | 'type' }> => {
  const readme = fs.readFileSync(path.join(docsDir, 'README.md'), 'utf8');
  return [...readme.matchAll(/^\| `([A-Za-z0-9_]+)`\s*\| (value|type)\s*\|/gm)].map(match => ({ name: match[1]!, kind: match[2] as 'value' | 'type' }));
};

describe('docs coverage gate', () => {
  it('documents every runtime barrel export at least once across docs/**/*.md', () => {
    const docsText = listMarkdownFiles(docsDir)
      .map(file => fs.readFileSync(file, 'utf8'))
      .join('\n');
    const exportNames = Object.keys(barrel).sort((left, right) => left.localeCompare(right));
    const missing = exportNames.filter(name => !new RegExp(`\\b${escapeRegExp(name)}\\b`).test(docsText));

    expect(missing).toEqual([]);
  });

  it('lists exactly the runtime barrel surface as value rows in the export reference', () => {
    const documentedValues = exportReferenceRows()
      .filter(row => row.kind === 'value')
      .map(row => row.name)
      .sort((left, right) => left.localeCompare(right));
    const barrelValues = Object.keys(barrel).sort((left, right) => left.localeCompare(right));

    expect(documentedValues).toEqual(barrelValues);
  });

  it('lists only types that are actually declared in the package for type rows', () => {
    const typesDir = path.join(root, 'src/types');
    const typeSource = fs
      .readdirSync(typesDir)
      .filter(file => file.endsWith('.ts'))
      .map(file => fs.readFileSync(path.join(typesDir, file), 'utf8'))
      .join('\n');
    const phantomTypes = exportReferenceRows()
      .filter(row => row.kind === 'type')
      .map(row => row.name)
      .filter(name => !new RegExp(`\\bexport (type|interface) ${escapeRegExp(name)}\\b`).test(typeSource));

    expect(phantomTypes).toEqual([]);
  });
});
