import fs from 'node:fs';
import path from 'node:path';

const srcRoot = path.resolve(__dirname, '../../..');

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(target);
    return /\.tsx?$/.test(entry.name) && !target.includes(`${path.sep}types${path.sep}`) ? [target] : [];
  });

const producersMatching = (pattern: RegExp): string[] =>
  sourceFiles(srcRoot)
    .filter(file => pattern.test(fs.readFileSync(file, 'utf8')))
    .map(file => path.relative(srcRoot, file))
    .sort();

/**
 * Every row that disappears must disappear because a declaration said so. The package has no
 * authority of its own to decide a row has outlived its usefulness, so the set of places that can
 * emit a destroy is closed, and each entry names the declaration that authorizes it. A maintenance
 * pass, a cache policy or a sweep added later lands outside this list and reddens the gate - which
 * is the point: reachability collection was once expressible here, and it silently discarded rows
 * whose only fault was that nothing happened to be reading them.
 */
const AUTHORIZED_DESTROY = new Map<string, string>([
  ['dsl/modelDirectAccess.ts', 'the consumer called destroy'],
  ['core/relations.ts', "a declared hasMany dependent: 'destroy' cascade"],
  ['dsl/facadeActions.ts', 'a model action declared an optimistic or confirmed destroy'],
  ['dsl/modelRootPlan.ts', 'a model root declaration selected a destroy'],
  ['dsl/modelWrites.ts', 'a write plan rolls its own optimistic insert back'],
  ['dsl/modelRegistrations.ts', 'a failed optimistic mutation is cleared by the consumer'],
  ['dsl/writePlan.ts', 'the consumer declared a destroy in the write plan'],
  ['core/bootFsck.ts', 'the boot fsck quarantines then destroys ownerless temp rows'],
  ['core/apply/commitEnvelope.ts', 'envelope construction, not a decision to delete'],
  ['core/apply/applyExecution.ts', 'applying a destroy already decided elsewhere']
]);

/**
 * The durable namespaces (`ops`, `ops-once`, `quarantine`) hold the user's unacknowledged writes.
 * Only their owning modules may build those storage keys; a new writer, migrator or cleanup pass
 * touching them lands outside this list and reddens the gate.
 */
const AUTHORIZED_DURABLE_KEY_BUILDERS = new Map<string, string>([
  ['core/planes/operationState.ts', 'the operation ledger owns ops and ops-once'],
  ['core/quarantine.ts', 'the quarantine owns its namespace'],
  ['core/schemaManifest.ts', 'an incompatible-format reset carries ops and quarantine through verbatim']
]);

const destroyProducers = producersMatching(/kind: 'destroy'/);
const durableKeyBuilders = producersMatching(/\}(ops|ops-once|quarantine)`/);

describe('outbox authority', () => {
  it('emits a destroy only from a path that names the declaration behind it', () => {
    expect(destroyProducers.filter(file => !AUTHORIZED_DESTROY.has(file))).toEqual([]);
  });

  it('keeps every authorized destroy producer real, so the list cannot outlive the code', () => {
    expect([...AUTHORIZED_DESTROY.keys()].filter(file => !destroyProducers.includes(file)).sort()).toEqual([]);
  });

  it('[P25] builds a durable storage key only from its owning module', () => {
    expect(durableKeyBuilders.filter(file => !AUTHORIZED_DURABLE_KEY_BUILDERS.has(file))).toEqual([]);
  });

  it('keeps every authorized durable key builder real, so the list cannot outlive the code', () => {
    expect([...AUTHORIZED_DURABLE_KEY_BUILDERS.keys()].filter(file => !durableKeyBuilders.includes(file)).sort()).toEqual([]);
  });
});
