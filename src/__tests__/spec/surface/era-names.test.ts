import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../../..');
const srcRoot = path.join(root, 'src');
const docsRoot = path.join(root, 'docs');
const eraPattern = new RegExp('\\b(v' + '[56])\\b', 'i');

const walk = (directory: string): string[] =>
  fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(target) : [target];
    });

const relative = (file: string) => path.relative(root, file).split(path.sep).join('/');

describe('era-free repository naming', () => {
  it('contains no era references in source or documentation', () => {
    const files = [...walk(srcRoot).filter(file => /\.tsx?$/.test(file)), ...walk(docsRoot).filter(file => file.endsWith('.md'))];
    const matches = files.flatMap(file => {
      const name = relative(file);
      if (name.startsWith('src/__tests__/') && !name.startsWith('src/__tests__/spec/')) return [];
      return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) => (eraPattern.test(line) ? [`${name}:${index + 1}:${line}`] : []));
    });

    expect(matches).toEqual([]);
  });

  it('contains no era references in source path segments', () => {
    const matches = walk(srcRoot)
      .map(relative)
      .filter(file => file.split('/').some(segment => eraPattern.test(segment)));

    expect(matches).toEqual([]);
  });

  it('contains no legacy compatibility terminology in production source', () => {
    const forbidden = /(legacy|shim|compat|Legacy|Shim|Compat)(?![a-z])/;
    const matches = walk(srcRoot)
      .filter(file => /\.tsx?$/.test(file) && !relative(file).startsWith('src/__tests__/'))
      .flatMap(file =>
        fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .flatMap((line, index) => (forbidden.test(line) ? [`${relative(file)}:${index + 1}:${line}`] : []))
      );

    expect(matches).toEqual([]);
  });
});
