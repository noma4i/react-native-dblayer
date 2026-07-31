import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const srcRoot = path.resolve(__dirname, '../../..');

/**
 * A durable payload field must have a CONSUMER, not just a validator. A shape check proves a
 * decoded record is well-formed; it never uses the value, so a field only its own predicate
 * mentions is dead weight in every persisted record and every restart path.
 *
 * A predicate DOES consume a field when it compares it to a declared constant: that is a version
 * or kind discriminator, and its value decides the outcome. A `typeof`/range/enum-literal check
 * decides nothing about the value itself.
 *
 * The field set is derived from source - every `value is T` predicate is a decode gate - so no
 * allowlist exists and a new dead field cannot be introduced silently.
 */
const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'types' ? [] : sourceFiles(target);
    return /\.tsx?$/.test(entry.name) ? [target] : [];
  });

const parsed = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

type Predicate = { file: string; name: string; body: string; shapeChecked: string[] };

/** Every `(value: unknown): value is T` arrow function, with the fields it only shape-checks. */
const typePredicates = (file: string): Predicate[] => {
  const source = parsed(file);
  const found: Predicate[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isArrowFunction(node) && node.type && ts.isTypePredicateNode(node.type) && node.parameters.length === 1) {
      const parameter = node.parameters[0]!.name.getText(source);
      const body = node.body.getText(source);
      const mentioned = [...body.matchAll(new RegExp(`\\b${parameter}\\.([a-zA-Z_]\\w*)`, 'g'))].map(match => match[1]!);
      // A comparison against a declared constant is a discriminator: the predicate reads the value.
      const discriminators = [...body.matchAll(new RegExp(`\\b${parameter}\\.([a-zA-Z_]\\w*)\\s*[!=]==\\s*([A-Za-z_]\\w*)`, 'g'))]
        .filter(match => !['undefined', 'null', 'true', 'false'].includes(match[2]!))
        .map(match => match[1]!);
      const shapeChecked = [...new Set(mentioned)].filter(field => !discriminators.includes(field));
      const declaration = ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(source) : '(anonymous)';
      if (shapeChecked.length > 0) found.push({ file, name: declaration, body, shapeChecked });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

describe('durable payload fields have consumers', () => {
  it('shape-checks no field that nothing outside the predicate ever reads', () => {
    const files = sourceFiles(srcRoot);
    const predicates = files.flatMap(typePredicates);
    expect(predicates.length).toBeGreaterThan(5);

    const allSource = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
    const outsidePredicates = predicates.reduce((text, predicate) => text.split(predicate.body).join(''), allSource);

    const violations = predicates.flatMap(predicate =>
      predicate.shapeChecked
        .filter(field => !new RegExp(`\\.${field}\\b|\\['${field}'\\]|\\b${field}\\s*[,}]`).test(outsidePredicates))
        .map(field => `${path.relative(srcRoot, predicate.file)} ${predicate.name}: ${field}`)
    );

    expect(violations).toEqual([]);
  });
});
