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

describe('docs coverage gate', () => {
  it('documents every runtime barrel export at least once across docs/**/*.md', () => {
    const docsText = listMarkdownFiles(docsDir)
      .map(file => fs.readFileSync(file, 'utf8'))
      .join('\n');
    const exportNames = Object.keys(barrel).sort((left, right) => left.localeCompare(right));
    const missing = exportNames.filter(name => !new RegExp(`\\b${escapeRegExp(name)}\\b`).test(docsText));

    expect(missing).toEqual([]);
  });
});
