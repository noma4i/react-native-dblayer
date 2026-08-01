/**
 * Jest config for Stryker mutation runs only.
 * Excludes spec/surface and nothing else: those are static repository-hygiene gates (docs sync, era
 * names, export allowlists, type snapshots) that scan repo files absent from the Stryker sandbox and
 * so cannot kill a runtime mutant. Every behavioural axis stays in - the work-counter and render-count
 * suites are the owner tests of the read path, and excluding them reported their mutants as survivors.
 */
const base = require('./jest.config');

module.exports = {
  ...base,
  coverageThreshold: undefined,
  testPathIgnorePatterns: ['/node_modules/', '/src/__tests__/spec/surface/']
};
