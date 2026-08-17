#!/usr/bin/env node
// Probative-assert gate (spec 10, section "probative assert"): a test case whose every assertion is
// a presence check, a bare not.toThrow(), a call-count without arguments, a comparison of two src
// calls, or an assertion guarded by `if`, proves nothing about the library. The gate scans the
// FORM of assertions and ratchets the count down; meaning is proven by red output on the named
// defect (T2), never by this script.
//
// Usage: node scripts/check-probative-asserts.mjs [--report] [--write-baseline]
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const LIB_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TEST_ROOT = path.join(LIB_ROOT, 'src', '__tests__');
const RATCHET = path.join(LIB_ROOT, 'scripts', '.probative-asserts-ratchet');
const PRESENCE = new Set(['toBeDefined', 'toBeTruthy', 'toBeFalsy']);
const CALL_ONLY = new Set(['toHaveBeenCalled', 'toHaveBeenCalledTimes', 'toBeCalled', 'toBeCalledTimes']);
const CHAIN_LINKS = new Set(['not', 'resolves', 'rejects']);
const EQUALITY = new Set(['toEqual', 'toBe', 'toStrictEqual']);

const walk = dir => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
};

/** Names imported from package source (not from test helpers): both sides of a self-compare must be among them. */
const srcImportNames = source => {
  const names = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const from = statement.moduleSpecifier.getText(source).slice(1, -1);
    const isSrc = from.startsWith('../../') && !from.includes('/helpers/') && !from.includes('/appshape/');
    if (!isSrc) continue;
    const { namedBindings, name } = statement.importClause;
    if (name) names.add(name.text);
    if (namedBindings && ts.isNamedImports(namedBindings)) for (const element of namedBindings.elements) names.add(element.name.text);
    if (namedBindings && ts.isNamespaceImport(namedBindings)) names.add(namedBindings.name.text);
  }
  return names;
};

const rootCallee = expression => {
  let node = expression;
  while (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
    node = node.expression;
  }
  return ts.isIdentifier(node) ? node.text : null;
};

const isGuardedByIf = call => {
  let node = call;
  while (node.parent && !ts.isBlock(node.parent) && !ts.isArrowFunction(node.parent) && !ts.isFunctionExpression(node.parent)) node = node.parent;
  // node is the statement holding the assertion; a bare `if (...) expect(...)` has the statement as thenStatement.
  const holder = node.parent && ts.isBlock(node.parent) ? node.parent : node;
  const owner = holder.parent;
  return Boolean(owner && ts.isIfStatement(owner) && (owner.thenStatement === holder || owner.thenStatement === node));
};

/** Classify the outermost matcher of one `expect(...)` chain; null = value assertion, undefined = not an assertion. */
const classifyAssertion = (call, srcNames) => {
  const parent = call.parent;
  if (parent && ts.isPropertyAccessExpression(parent) && (CHAIN_LINKS.has(parent.name.text) || (parent.parent && ts.isCallExpression(parent.parent) && parent.parent.expression === parent))) return undefined;
  const chain = [];
  let node = call;
  while (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    chain.unshift({ name: node.expression.name.text, args: node.arguments });
    node = node.expression.expression;
    while (ts.isPropertyAccessExpression(node) && CHAIN_LINKS.has(node.name.text)) {
      chain.unshift({ name: node.name.text, args: [] });
      node = node.expression;
    }
  }
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'expect') return undefined;
  const subject = node.arguments[0];
  const matcher = chain[chain.length - 1];
  if (!matcher) return undefined;
  const negated = chain.some(link => link.name === 'not');
  if (PRESENCE.has(matcher.name)) return 'presence';
  if (matcher.name === 'toThrow' && negated && matcher.args.length === 0) return 'not-throw';
  if (CALL_ONLY.has(matcher.name)) return 'call-count';
  if (EQUALITY.has(matcher.name) && matcher.args.length === 1 && subject && ts.isCallExpression(subject) && ts.isCallExpression(matcher.args[0])) {
    const left = rootCallee(subject.expression);
    const right = rootCallee(matcher.args[0].expression);
    if (left && right && srcNames.has(left) && srcNames.has(right)) return 'self-compare';
  }
  if (isGuardedByIf(call)) return 'guarded';
  return null;
};

const isTestCall = node =>
  ts.isCallExpression(node) &&
  ((ts.isIdentifier(node.expression) && (node.expression.text === 'it' || node.expression.text === 'test')) ||
    (ts.isCallExpression(node.expression) && ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === 'each' && ['it', 'test'].includes(rootCallee(node.expression.expression) ?? ''))) &&
  node.arguments.length >= 2;

const scanFile = file => {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const srcNames = srcImportNames(source);
  const findings = [];
  let cases = 0;
  const visit = node => {
    if (isTestCall(node)) {
      cases += 1;
      const name = ts.isStringLiteralLike(node.arguments[0]) ? node.arguments[0].text : node.arguments[0].getText(source);
      const asserts = [];
      const collect = inner => {
        if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression)) {
          const verdict = classifyAssertion(inner, srcNames);
          if (verdict !== undefined) asserts.push(verdict);
        }
        // A file-local assertion helper (expectX / assertX) is a value assertion the gate does not see into.
        if (ts.isCallExpression(inner) && (ts.isIdentifier(inner.expression) || ts.isPropertyAccessExpression(inner.expression))) {
          const helper = ts.isIdentifier(inner.expression) ? inner.expression.text : inner.expression.name.text;
          if (/^(expect|assert)[A-Z]/.test(helper)) asserts.push(null);
        }
        ts.forEachChild(inner, collect);
      };
      collect(node.arguments[1]);
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      if (asserts.length === 0) findings.push({ line, name, verdict: 'no-assert' });
      else if (asserts.every(verdict => verdict !== null)) findings.push({ line, name, verdict: [...new Set(asserts)].join('+') });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { cases, findings };
};

const report = process.argv.includes('--report');
const writeBaseline = process.argv.includes('--write-baseline');
let total = 0;
let flagged = 0;
const lines = [];
for (const file of walk(TEST_ROOT)) {
  const { cases, findings } = scanFile(file);
  total += cases;
  flagged += findings.length;
  for (const finding of findings) lines.push(`${path.relative(TEST_ROOT, file)}:${finding.line} [${finding.verdict}] ${finding.name.slice(0, 90)}`);
}
if (report) for (const line of lines) console.log(line);
console.log(`probative-asserts: ${total} cases, ${flagged} form-flagged`);
if (writeBaseline) {
  writeFileSync(RATCHET, `${flagged}\n`);
  console.log(`baseline written: ${flagged}`);
  process.exit(0);
}
let baseline;
try {
  baseline = Number(readFileSync(RATCHET, 'utf8').trim());
} catch {
  console.error('probative-asserts: ratchet file missing (run with --write-baseline once)');
  process.exit(1);
}
if (flagged > baseline) {
  console.error(`probative-asserts: RED - form-flagged cases grew ${baseline} -> ${flagged}; run with --report`);
  process.exit(1);
}
console.log(`probative-asserts: OK (baseline ${baseline})`);
