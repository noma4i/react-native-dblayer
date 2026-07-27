import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Structural counterpart to the behavioral atomicity specs (i-detached-operations.test.tsx B1-B4,
// i-mutation-atomicity.test.tsx M1-M5): a ledger transition (`begin`/`close`/`remove`) and the row
// mutation (`apply`) it describes must land in one persisted write via `apply(ops, { extraEntries })`.
// This scans every function body for the SHAPE of the defect - a naked `apply(` call missing
// `extraEntries` coexisting with a naked ledger-transition call missing `{ persist: false }` - so the
// two-step gap cannot be reintroduced without this test failing, independent of which file it lands in.

const srcRoot = path.resolve(__dirname, '../../..');

/**
 * `runWithTempId` legitimately mixes combined pairs with genuinely standalone calls in the SAME
 * function (e.g. an empty-ops branch that only closes, or the untracked branch that only applies) -
 * this scanner groups by enclosing function, not by branch, so it cannot tell those apart from a real
 * two-step gap on its own. Each entry here was individually verified to have no paired call to combine
 * with (see git history for `defineDetachedOperation.ts` B1-B4 / `i-mutation-atomicity.test.tsx` M1-M5,
 * the behavioral counterparts that would catch a regression here even if this list masked it).
 */
/**
 * Marker a call site must carry to be accepted as legitimately standalone, followed by the reason.
 *
 * The exemption is keyed by this marker rather than by a file/line pair on purpose. A line-keyed
 * allowlist fails OPEN: once any refactor shifts lines, a genuinely two-step write that lands on a
 * listed line is silently accepted, which is exactly the defect this gate exists to prevent. A marker
 * travels with the call, so a newly introduced two-step write can never inherit an exemption.
 */
const STANDALONE_MARKER = 'ledger-standalone:';

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === '__tests__') return [];
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.tsx?$/.test(entry.name) ? [target] : [];
  });

const isFunctionLike = (node: ts.Node): node is ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);

const objectLiteralArgs = (call: ts.CallExpression): ts.ObjectLiteralExpression[] => call.arguments.filter(ts.isObjectLiteralExpression);

/** True when one of `call`'s object-literal arguments carries a `persist: false` property. */
const hasPersistFalse = (call: ts.CallExpression): boolean =>
  objectLiteralArgs(call).some(object =>
    object.properties.some(
      prop => ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'persist' && prop.initializer.kind === ts.SyntaxKind.FalseKeyword
    )
  );

/** True when one of `call`'s object-literal arguments carries an `extraEntries` property. */
const hasExtraEntries = (call: ts.CallExpression): boolean =>
  objectLiteralArgs(call).some(object =>
    object.properties.some(prop => (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) && ts.isIdentifier(prop.name) && prop.name.text === 'extraEntries')
  );

/** The `.foo` in a `x.foo(...)` call, or `undefined` for a bare `foo(...)` call. */
const calleePropertyName = (call: ts.CallExpression): string | undefined => (ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : undefined);

const LEDGER_TRANSITION_NAMES = new Set(['close', 'remove', 'begin']);

/** Calls directly owned by one function body - does NOT descend into a nested function-like node, since that is its own unit. */
const collectShallowCalls = (owner: ts.Node): ts.CallExpression[] => {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== owner && isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(owner, visit);
  return calls;
};

type Violation = { file: string; line: number; kind: string };

const scanFile = (file: string): Violation[] => {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const violations: Violation[] = [];

  /** True when the call's own opening line carries the standalone marker explaining why it has no pair. */
  const isMarkedStandalone = (call: ts.CallExpression): boolean => {
    const { line } = source.getLineAndCharacterOfPosition(call.getStart(source));
    return lines[line]?.includes(STANDALONE_MARKER) === true;
  };

  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node) && node.body) {
      const calls = collectShallowCalls(node).filter(call => !isMarkedStandalone(call));
      const nakedApplies = calls.filter(call => calleePropertyName(call) === 'apply' && !hasExtraEntries(call));
      const nakedLedgerCalls = calls.filter(call => {
        const name = calleePropertyName(call);
        return name !== undefined && LEDGER_TRANSITION_NAMES.has(name) && !hasPersistFalse(call);
      });
      if (nakedApplies.length > 0 && nakedLedgerCalls.length > 0) {
        for (const call of [...nakedApplies, ...nakedLedgerCalls]) {
          const { line } = source.getLineAndCharacterOfPosition(call.getStart(source));
          violations.push({ file: path.relative(srcRoot, file), line: line + 1, kind: calleePropertyName(call)! });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
};

describe('ledger/row persist atomicity discipline', () => {
  it('never lets a ledger transition and its paired row mutation persist as two independent writes', () => {
    const violations = sourceFiles(srcRoot).flatMap(scanFile);
    expect(violations).toEqual([]);
  });
});
