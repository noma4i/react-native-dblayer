import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const specRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(__dirname, '../../../..');

/**
 * The signs of a suite that cannot fail, checked instead of listed. A test with no assertion, an
 * assertion comparing a value to itself, and a runner flag that silences what the suite failed to
 * clean up all produce the same thing: a green run that proves nothing. Each one is cheap to write
 * by accident and impossible to notice by reading a passing report.
 */
const testFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(target);
    return /\.test\.tsx?$/.test(entry.name) ? [target] : [];
  });

const parsed = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const isTestCall = (node: ts.Node): node is ts.CallExpression => {
  if (!ts.isCallExpression(node)) return false;
  const target = ts.isPropertyAccessExpression(node.expression) ? node.expression.expression : node.expression;
  return ts.isIdentifier(target) && ['it', 'test'].includes(target.text);
};

const bodyOf = (call: ts.CallExpression): ts.Node | undefined => {
  const last = call.arguments[call.arguments.length - 1];
  return last && (ts.isArrowFunction(last) || ts.isFunctionExpression(last)) ? last.body : undefined;
};

const contains = (node: ts.Node, predicate: (child: ts.Node) => boolean): boolean => {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (predicate(child)) found = true;
    else ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
};

/**
 * An assertion is `expect`, or a call to a helper that asserts on the case's behalf. A case that
 * delegates its checking to a named helper still checks something; only a case that reaches no
 * assertion at all passes whatever the code does.
 */
const ASSERTING_NAMES = /^(expect|assert|verify|check)/i;

const isAssertion = (node: ts.Node): boolean => {
  if (!ts.isCallExpression(node)) return false;
  const target = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
  return ts.isIdentifier(target) && ASSERTING_NAMES.test(target.text);
};

const location = (source: ts.SourceFile, node: ts.Node): string =>
  `${path.relative(repoRoot, source.fileName)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;

/** A case that asserts nothing: it passes whatever the code does. */
const assertionFreeCases = (file: string): string[] => {
  const source = parsed(file);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (isTestCall(node)) {
      const body = bodyOf(node);
      // A case with no body at all is a declaration of intent (`it.todo`-style), not a silent pass.
      if (body && !contains(body, isAssertion)) found.push(location(source, node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

/** An assertion whose two sides are the same expression: true whatever the code computed. */
const tautologicalAsserts = (file: string): string[] => {
  const source = parsed(file);
  const found: string[] = [];
  const isComparableExpression = (node: ts.Node): boolean =>
    ts.isIdentifier(node) ||
    ts.isLiteralExpression(node) ||
    [ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword].includes(node.kind) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isCallExpression(node);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['toBe', 'toEqual', 'toStrictEqual', 'toMatchObject'].includes(node.expression.name.text) &&
      ts.isCallExpression(node.expression.expression) &&
      ts.isIdentifier(node.expression.expression.expression) &&
      node.expression.expression.expression.text === 'expect' &&
      node.arguments.length === 1 &&
      node.expression.expression.arguments.length === 1 &&
      isComparableExpression(node.arguments[0]!) &&
      isComparableExpression(node.expression.expression.arguments[0]!) &&
      node.arguments[0]!.getText(source) === node.expression.expression.arguments[0]!.getText(source)
    ) {
      found.push(location(source, node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

describe('suite honesty', () => {
  it('asserts something in every case', () => {
    expect(testFiles(specRoot).flatMap(assertionFreeCases)).toEqual([]);
  });

  it('compares no value to itself', () => {
    expect(testFiles(specRoot).flatMap(tautologicalAsserts)).toEqual([]);
  });

  it('silences no open handle through a runner flag', () => {
    const configs = ['jest.config.js', 'jest.stryker.config.js', 'package.json', 'scripts/run-jest-shards.mjs'];
    const offenders = configs.filter(name => /forceExit|detectOpenHandles\s*:\s*false/.test(fs.readFileSync(path.join(repoRoot, name), 'utf8')));

    expect(offenders).toEqual([]);
  });
});
