import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const srcRoot = path.resolve(__dirname, '../../..');
const orderingHome = path.join(srcRoot, 'core/ordering.ts');

/**
 * Ordering has ONE home. A consumer comparator reports a tie by returning zero and decides nothing
 * further; only the canonical id tie-break settles it. A module that feeds a raw comparator into
 * `sort` or `reduce` invents a second answer for the same question - the winner then depends on the
 * order rows arrived in, and two read surfaces of one relation disagree.
 */
const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'types' ? [] : sourceFiles(target);
    return /\.tsx?$/.test(entry.name) ? [target] : [];
  });

const parsed = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/**
 * The ordering home defines what canonical means: everything it exports, plus the primitives it
 * builds on. Both sets come from that module, so no name is listed here.
 */
const canonicalNames = (): Set<string> => {
  const source = parsed(orderingHome);
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of node.declarationList.declarations) names.add(declaration.name.getText(source));
    }
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const element of node.importClause.namedBindings.elements) names.add(element.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
};

/** Identifiers a module binds from a canonical ordering export, plus the canonical names themselves. */
const tieBrokenNames = (source: ts.SourceFile, canonical: Set<string>): Set<string> => {
  const names = new Set(canonical);
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      canonical.has(node.initializer.expression.text)
    ) {
      names.add(node.name.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
};

/** Every `sort`/`reduce` argument that calls a comparator-shaped identifier the module never tie-broke. */
const rawComparatorUses = (file: string, canonical: Set<string>): string[] => {
  const source = parsed(file);
  const safe = tieBrokenNames(source, canonical);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['sort', 'reduce'].includes(node.expression.name.text) &&
      node.arguments.length > 0
    ) {
      const argument = node.arguments[0]!.getText(source);
      const called = [...argument.matchAll(/\b(\w*[Cc]omparator|compare\w*)\s*[!]?\s*\(/g)].map(match => match[1]!);
      for (const name of called) {
        if (!safe.has(name)) violations.push(`${path.relative(srcRoot, file)}: ${name} in .${node.expression.name.text}()`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
};

/**
 * A hand-rolled field comparison: `left < right ? -1 : 1` and its shapes. Ordering has one home, so a
 * module that decides order itself has quietly forked the total order - and its version has no id
 * tie-break, which is exactly how two surfaces of one relation start naming different rows.
 */
const handRolledComparisons = (file: string): string[] => {
  const source = parsed(file);
  const violations: string[] = [];
  const isOrderNumber = (node: ts.Expression, value: number): boolean =>
    (ts.isNumericLiteral(node) && Number(node.text) === Math.abs(value)) ||
    (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand) && Number(node.operand.text) === Math.abs(value));
  const visit = (node: ts.Node): void => {
    if (
      ts.isConditionalExpression(node) &&
      ts.isBinaryExpression(node.condition) &&
      [ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken].includes(node.condition.operatorToken.kind) &&
      isOrderNumber(node.whenTrue, 1) &&
      isOrderNumber(node.whenFalse, 1)
    ) {
      violations.push(`${path.relative(srcRoot, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
};

describe('ordering discipline', () => {
  it('decides order in one home, never by a hand-rolled field comparison', () => {
    const violations = sourceFiles(srcRoot)
      .filter(file => file !== orderingHome)
      .flatMap(handRolledComparisons);

    expect(violations).toEqual([]);
  });

  it('feeds no raw consumer comparator into sort or reduce outside the ordering home', () => {
    const canonical = canonicalNames();
    expect(canonical.size).toBeGreaterThan(3);
    const violations = sourceFiles(srcRoot)
      .filter(file => file !== orderingHome)
      .flatMap(file => rawComparatorUses(file, canonical));

    expect(violations).toEqual([]);
  });
});
