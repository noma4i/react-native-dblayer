/**
 * Jest config for Stryker mutation runs only.
 * Excludes spec/surface: those are static repository-hygiene gates (docs sync, era names,
 * export allowlists, type snapshots) that scan repo files absent from the Stryker sandbox
 * and by design cannot kill runtime mutants.
 * Excludes perf/appshape/rerender: scale-shaped work-counter suites are the most expensive
 * runs and the weakest mutant killers - dropping them keeps the whole audit inside the
 * owner-mandated 3-minute budget (behavior suites carry the killing power).
 */
const base = require('./jest.config');

module.exports = {
  ...base,
  coverageThreshold: undefined,
  testPathIgnorePatterns: [
    '/node_modules/',
    '/src/__tests__/spec/surface/',
    '/src/__tests__/spec/perf/',
    '/src/__tests__/spec/appshape/',
    '/src/__tests__/spec/rerender/'
  ]
};
