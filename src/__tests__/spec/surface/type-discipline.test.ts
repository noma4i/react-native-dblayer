import fs from 'node:fs';
import path from 'node:path';

type PatternRule = {
  pattern: string;
  regex: RegExp;
};

type Violation = {
  file: string;
  line: number;
  pattern: string;
};

type AllowedViolation = {
  file: string;
  pattern: string;
  reason: string;
};

const root = path.resolve(__dirname, '../../../..');
const srcRoot = path.join(root, 'src');

const walker = (directory: string): string[] =>
  fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walker(target);
      return /\.tsx?$/.test(entry.name) ? [target] : [];
    });

const rules: PatternRule[] = [
  { pattern: ': any', regex: /:\s*any\b/ },
  { pattern: '<any>', regex: /<\s*any\s*>/ },
  { pattern: 'any[]', regex: /\bany\s*\[\]/ },
  { pattern: 'as any', regex: /\bas\s+any\b/ },
  { pattern: 'as unknown as', regex: /\bas\s+unknown\s+as\b/ },
  { pattern: '@ts-ignore', regex: /@ts-ignore/ },
  { pattern: '@ts-expect-error', regex: /@ts-expect-error/ },
  { pattern: '@ts-nocheck', regex: /@ts-nocheck/ }
];

const allowlist: AllowedViolation[] = [
  {
    file: 'src/core/apply/commitEnvelope.ts',
    pattern: 'as unknown as',
    reason: 'createCommitEnvelope is the single brand-stamping factory; the CommitEnvelope brand symbol is type-only (declared in src/types) and cannot be produced structurally'
  },
  {
    file: 'src/core/subscriptionRuntime.ts',
    pattern: 'as unknown as',
    reason: 'TypedDocumentNode variance plus Object.fromEntries, dynamic-key tuple, and runtime payload erasure at external type boundaries'
  }
];

const relative = (file: string) => path.relative(root, file).split(path.sep).join('/');

const collectViolations = (): Violation[] =>
  walker(srcRoot)
    .filter(file => !relative(file).startsWith('src/__tests__/'))
    .flatMap(file => {
      const source = fs.readFileSync(file, 'utf8').split('\n');
      const name = relative(file);
      return source.flatMap((line, index) =>
        rules.flatMap(rule => {
          if (!rule.regex.test(line)) return [];
          return [{ file: name, line: index + 1, pattern: rule.pattern }];
        })
      );
    });

const key = (violation: { file: string; pattern: string }) => `${violation.file}|${violation.pattern}`;

const declarationSites = (): Map<string, string[]> => {
  const sites = new Map<string, string[]>();
  walker(srcRoot)
    .filter(file => !relative(file).startsWith('src/__tests__/'))
    .forEach(file => {
      const name = relative(file);
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach(line => {
          const match = /^export (?:type|interface) ([A-Za-z0-9_]+)/.exec(line);
          if (match) sites.set(match[1], [...(sites.get(match[1]) ?? []), name]);
        });
    });
  return sites;
};

describe('type discipline', () => {
  it('contains no un-allowlisted typing exceptions in production source', () => {
    const violations = collectViolations();
    const allowlisted = new Set(allowlist.map(item => key(item)));
    const unexpected = violations.filter(entry => !allowlisted.has(key(entry)));
    const stale = allowlist.filter(item => !violations.some(entry => key(entry) === key(item)));

    expect(unexpected).toEqual([]);
    expect(stale).toEqual([]);
  });

  it('declares every exported type name in exactly one module', () => {
    const duplicated = [...declarationSites().entries()]
      .filter(([, files]) => files.length > 1)
      .map(([name, files]) => `${name}: ${files.join(' + ')}`)
      .sort();

    expect(duplicated).toEqual([]);
  });

  it('declares types only inside src/types', () => {
    // The types store is the single home for every type/interface declaration - exported or local.
    // Runtime modules import their shapes from '../types'; a declaration outside src/types is a miss
    // of the extraction convention, not a style choice.
    const offenders = walker(srcRoot)
      .filter(file => !relative(file).startsWith('src/__tests__/') && !relative(file).startsWith('src/types/'))
      .flatMap(file =>
        fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => /^\s*(?:export\s+)?(?:type|interface)\s+[A-Za-z]/.test(line) && !/^\s*export\s+type\s+\{/.test(line))
          .map(({ line, index }) => `${relative(file)}:${index + 1}: ${line.trim().slice(0, 60)}`)
      )
      .sort();

    expect(offenders).toEqual([]);
  });

  it('re-exports types only from the two entry points', () => {
    // Both re-export forms count: `export type {...} from '...'` and the bare `export type { X };`.
    const entryPoints = new Set(['src/index.ts', 'src/types/index.ts']);
    const offenders = walker(srcRoot)
      .filter(file => !relative(file).startsWith('src/__tests__/') && !entryPoints.has(relative(file)))
      .flatMap(file =>
        fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .filter(line => /^export type \{[^}]*\}/.test(line))
          .map(line => `${relative(file)}: ${line.trim()}`)
      )
      .sort();

    expect(offenders).toEqual([]);
  });
});
