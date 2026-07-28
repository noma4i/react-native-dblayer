/**
 * Jest config for Stryker mutation runs only.
 * Excludes spec/surface: those are static repository-hygiene gates (docs sync, era names,
 * export allowlists, type snapshots) that scan repo files absent from the Stryker sandbox
 * and by design cannot kill runtime mutants.
 */
const base = require('./jest.config');

module.exports = {
  ...base,
  coverageThreshold: undefined,
  testPathIgnorePatterns: ['/node_modules/', '/src/__tests__/spec/surface/', '/src/spike/']
};
