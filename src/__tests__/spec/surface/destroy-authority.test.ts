import fs from 'node:fs';
import path from 'node:path';

const srcRoot = path.resolve(__dirname, '../../..');

/**
 * Every row that disappears must disappear because a declaration said so. The package has no
 * authority of its own to decide a row has outlived its usefulness, so the set of places that can
 * emit a destroy is closed, and each entry names the declaration that authorizes it. A maintenance
 * pass, a cache policy or a sweep added later lands outside this list and reddens the gate - which
 * is the point: reachability collection was once expressible here, and it silently discarded rows
 * whose only fault was that nothing happened to be reading them.
 */
const AUTHORIZED = new Map<string, string>([
  ['dsl/modelDirectAccess.ts', 'the consumer called destroy'],
  ['dsl/defineIngest.ts', 'a server event declared the row deleted'],
  ['core/relations.ts', "a declared hasMany dependent: 'destroy' cascade"],
  ['dsl/mutationRuntime.ts', 'a mutation destroys optimistically or rolls its own optimistic insert back'],
  ['dsl/mutationResponder.ts', 'a mutation response rolls its own optimistic insert back'],
  ['dsl/modelWrites.ts', 'a write plan rolls its own optimistic insert back'],
  ['dsl/modelRegistrations.ts', 'a failed optimistic mutation is cleared by the consumer'],
  ['dsl/defineDetachedOperation.ts', 'a detached operation rolls its own optimistic insert back'],
  ['dsl/writePlan.ts', 'the consumer declared a destroy in the write plan'],
  ['dsl/configure.ts', 'replay drops temp rows of operations that cannot resume across a restart'],
  ['core/apply/commitEnvelope.ts', 'envelope construction, not a decision to delete'],
  ['core/apply/applyExecution.ts', 'applying a destroy already decided elsewhere']
]);

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(target);
    return /\.tsx?$/.test(entry.name) && !target.includes(`${path.sep}types${path.sep}`) ? [target] : [];
  });

const producers = sourceFiles(srcRoot)
  .filter(file => /kind: 'destroy'/.test(fs.readFileSync(file, 'utf8')))
  .map(file => path.relative(srcRoot, file))
  .sort();

describe('destroy authority', () => {
  it('emits a destroy only from a path that names the declaration behind it', () => {
    expect(producers.filter(file => !AUTHORIZED.has(file))).toEqual([]);
  });

  it('keeps every authorized producer real, so the list cannot outlive the code', () => {
    expect([...AUTHORIZED.keys()].filter(file => !producers.includes(file)).sort()).toEqual([]);
  });
});
