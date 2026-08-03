import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const userArgs = process.argv.slice(2);
const coverage = userArgs.includes('--coverage');
const timeoutMs = Number.parseInt(process.env.DBLAYER_JEST_TIMEOUT_MS ?? (coverage ? '60000' : '30000'), 10);
const requestedShardCount = Number.parseInt(
  process.env.DBLAYER_JEST_SHARDS ?? String(Math.min(4, Math.max(2, availableParallelism()))),
  10
);

const discoverTestFiles = (directory) => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...discoverTestFiles(path));
    else if (/\.test\.tsx?$/.test(entry.name) && path.includes(`${join('src', '__tests__')}`)) files.push(path);
  }
  return files;
};

const testFiles = process.env.DBLAYER_JEST_TEST_FILES
  ? JSON.parse(process.env.DBLAYER_JEST_TEST_FILES)
  : discoverTestFiles(join(rootDir, 'src')).sort();

const createShards = (files, count) => {
  const shards = Array.from({ length: Math.min(Math.max(1, count), files.length) }, () => ({ files: [], weight: 0 }));
  const weighted = files
    .map((file) => ({ file, weight: existsSync(file) ? statSync(file).size : 1 }))
    .sort((left, right) => right.weight - left.weight || left.file.localeCompare(right.file));

  for (const item of weighted) {
    const shard = shards.reduce((lightest, candidate) => (candidate.weight < lightest.weight ? candidate : lightest));
    shard.files.push(item.file);
    shard.weight += item.weight;
  }
  return shards.map((shard) => shard.files.sort());
};

const runJest = (arguments_, label) =>
  new Promise((resolveRun) => {
    const jestBin = process.env.DBLAYER_JEST_BIN ?? require.resolve('jest/bin/jest');
    const child = spawn(process.execPath, [jestBin, ...arguments_], {
      cwd: rootDir,
      env: process.env,
      stdio: 'inherit'
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      process.stderr.write(`${label} timed out after ${timeoutMs}ms\n`);
      child.kill('SIGTERM');
    }, timeoutMs);
    const killTimer = setTimeout(() => {
      if (timedOut && child.exitCode == null) child.kill('SIGKILL');
    }, timeoutMs + 1_000);

    child.once('error', (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.stderr.write(`${label} failed to start: ${error.message}\n`);
      resolveRun(1);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (timedOut) resolveRun(124);
      else if (signal) {
        process.stderr.write(`${label} exited on signal ${signal}\n`);
        resolveRun(1);
      } else resolveRun(code ?? 1);
    });
  });

const mergeCoverage = (directories, coverageDirectory) => {
  const { createCoverageMap } = require('istanbul-lib-coverage');
  const { createContext } = require('istanbul-lib-report');
  const reports = require('istanbul-reports');
  const coverageMap = createCoverageMap({});

  for (const directory of directories) {
    coverageMap.merge(JSON.parse(readFileSync(join(directory, 'coverage-final.json'), 'utf8')));
  }

  mkdirSync(coverageDirectory, { recursive: true });
  writeFileSync(join(coverageDirectory, 'coverage-final.json'), JSON.stringify(coverageMap.toJSON()));
  const context = createContext({ coverageMap, dir: coverageDirectory });
  reports.create('text').execute(context);
  reports.create('lcovonly').execute(context);

  const thresholds = require(join(rootDir, 'jest.config.js')).coverageThreshold?.global ?? {};
  const summary = coverageMap.getCoverageSummary().toJSON();
  const failures = Object.entries(thresholds)
    .filter(([metric, threshold]) => summary[metric].pct < threshold)
    .map(([metric, threshold]) => `${metric}: ${summary[metric].pct}% < ${threshold}%`);
  if (failures.length > 0) {
    process.stderr.write(`Coverage thresholds failed:\n${failures.join('\n')}\n`);
    return 1;
  }
  return 0;
};

const selectorArgs = userArgs.filter((argument) => argument !== '--coverage');

if (selectorArgs.length > 0) {
  process.exitCode = await runJest(['--runInBand', '--silent', ...userArgs], 'Jest');
} else {
  const shards = createShards(testFiles, requestedShardCount);
  const coverageDirectory = join(rootDir, 'coverage');
  const coverageShardDirectories = shards.map((_, index) => join(coverageDirectory, `shard-${index + 1}`));
  if (coverage) rmSync(coverageDirectory, { recursive: true, force: true });

  const results = await Promise.all(
    shards.map((files, index) => {
      const arguments_ = ['--runInBand', '--silent', '--runTestsByPath', ...files];
      if (coverage) {
        arguments_.push(
          '--coverage',
          `--coverageDirectory=${coverageShardDirectories[index]}`,
          '--coverageReporters=json',
          '--coverageThreshold={}'
        );
      }
      return runJest(arguments_, `Jest shard ${index + 1}/${shards.length}`);
    })
  );
  process.exitCode = results.some((code) => code !== 0)
    ? 1
    : coverage
      ? mergeCoverage(coverageShardDirectories, coverageDirectory)
      : 0;
}
