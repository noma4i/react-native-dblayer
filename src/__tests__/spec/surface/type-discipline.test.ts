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
  { file: 'src/core/subscriptionRuntime.ts', pattern: ': any', reason: 'pre-existing - scheduled for T8 sweep' },
  { file: 'src/core/subscriptionRuntime.ts', pattern: 'any[]', reason: 'pre-existing - scheduled for T8 sweep' },
  { file: 'src/core/subscriptionRuntime.ts', pattern: '<any>', reason: 'pre-existing - scheduled for T8 sweep' },
  { file: 'src/core/subscriptionRuntime.ts', pattern: 'as unknown as', reason: 'pre-existing - scheduled for T8 sweep' },
  { file: 'src/core/tanstack/facade.ts', pattern: 'as unknown as', reason: 'pre-existing - scheduled for T8 sweep' },
  { file: 'src/core/tanstack/liveScopeReads.ts', pattern: 'as unknown as', reason: 'pre-existing - scheduled for T8 sweep' },
  { file: 'src/core/tanstack/mirror.ts', pattern: 'as unknown as', reason: 'pre-existing - scheduled for T8 sweep' },
  { file: 'src/dsl/defineModel.ts', pattern: ': any', reason: 'pre-existing - scheduled for T8 sweep' },
  { file: 'src/dsl/defineModel.ts', pattern: 'any[]', reason: 'pre-existing - scheduled for T8 sweep' },
  { file: 'src/dsl/defineModel.ts', pattern: '<any>', reason: 'pre-existing - scheduled for T8 sweep' },
  { file: 'src/dsl/defineModel.ts', pattern: 'as any', reason: 'pre-existing - scheduled for T8 sweep' },
  { file: 'src/read/incrementalReadEngine.ts', pattern: 'as unknown as', reason: 'pre-existing - scheduled for T8 sweep' },
  { file: 'src/schema/shape.ts', pattern: '<any>', reason: 'pre-existing - scheduled for T8 sweep' },
  { file: 'src/utils/pickDefined.ts', pattern: 'as unknown as', reason: 'pre-existing - scheduled for T8 sweep' }
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

describe('type discipline', () => {
  it('contains no un-allowlisted typing exceptions in production source', () => {
    const violations = collectViolations();
    const allowlisted = new Set(allowlist.map(item => key(item)));
    const unexpected = violations.filter(entry => !allowlisted.has(key(entry)));
    const stale = allowlist.filter(item => !violations.some(entry => key(entry) === key(item)));

    expect(unexpected).toEqual([]);
    expect(stale).toEqual([]);  });
});
