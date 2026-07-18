#!/usr/bin/env node
// Checks that every value export reachable from an entry file carries a JSDoc block
// comment on its declaration (or, for overloaded functions, on any overload).
// Usage: node scripts/check-jsdoc.mjs [--entry <path>]

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const args = process.argv.slice(2);
const entryFlagIndex = args.indexOf('--entry');
const entryArg = entryFlagIndex >= 0 ? args[entryFlagIndex + 1] : 'src/index.ts';
const entryPath = path.resolve(process.cwd(), entryArg);

const readSource = filePath =>
  ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const resolveModuleFile = (fromFile, moduleSpecifier) => {
  const base = path.resolve(path.dirname(fromFile), moduleSpecifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot resolve module "${moduleSpecifier}" from ${fromFile}`);
};

const lineOf = (sourceFile, node) => sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
const isExported = statement => statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
const hasJsDoc = node => ts.getJSDocCommentsAndTags(node).some(ts.isJSDoc);

// Finds every top-level exported declaration named `name` in a file - functions may have
// several (overload signatures plus the implementation); variables have exactly one.
const findDeclarations = (sourceFile, name) => {
  const results = [];
  for (const statement of sourceFile.statements) {
    if (!isExported(statement)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) results.push(statement);
    else if (ts.isClassDeclaration(statement) && statement.name?.text === name) results.push(statement);
    else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) results.push(decl);
      }
    }
  }
  return results;
};

// Returns the function-like node (for @param/@returns inspection) or null.
const functionLike = node => {
  if (ts.isFunctionDeclaration(node)) return node;
  if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    return node.initializer;
  }
  return null;
};

const returnsNonVoid = fn => !!fn.type && !['void', 'undefined'].includes(fn.type.getText());

// Collects { exportedName, localName, targetFile, targetSource } for every value export
// reachable from the entry file: its own direct exported declarations, plus one hop
// through `export { a, b } from './mod'` (and local `export { a, b }` without `from`).
const collectExportTasks = (entryPath, entrySource) => {
  const tasks = [];
  const directNames = new Set();
  for (const statement of entrySource.statements) {
    if (!isExported(statement)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name) directNames.add(statement.name.text);
    else if (ts.isClassDeclaration(statement) && statement.name) directNames.add(statement.name.text);
    else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) directNames.add(decl.name.text);
      }
    }
  }
  for (const name of directNames) tasks.push({ exportedName: name, localName: name, targetFile: entryPath, targetSource: entrySource });

  for (const statement of entrySource.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    const targetFile = statement.moduleSpecifier ? resolveModuleFile(entryPath, statement.moduleSpecifier.text) : entryPath;
    const targetSource = statement.moduleSpecifier ? readSource(targetFile) : entrySource;
    for (const specifier of statement.exportClause.elements) {
      if (specifier.isTypeOnly) continue;
      const exportedName = specifier.name.text;
      const localName = (specifier.propertyName ?? specifier.name).text;
      tasks.push({ exportedName, localName, targetFile, targetSource });
    }
  }
  return tasks;
};

const entrySource = readSource(entryPath);
const tasks = collectExportTasks(entryPath, entrySource);
const violations = [];
const warnings = [];

for (const { exportedName, localName, targetFile, targetSource } of tasks) {
  const declarations = findDeclarations(targetSource, localName);
  if (declarations.length === 0) {
    throw new Error(`check-jsdoc: could not locate declaration for "${localName}" (exported as "${exportedName}") in ${targetFile}`);
  }
  const docNode = declarations.find(hasJsDoc);
  if (!docNode) {
    violations.push(`MISSING-JSDOC ${exportedName} ${targetFile}:${lineOf(targetSource, declarations[0])}`);
    continue;
  }
  const fn = functionLike(docNode);
  if (!fn) continue;
  const tags = ts.getJSDocTags(docNode).map(tag => tag.tagName.text);
  if (fn.parameters.length > 0 && !tags.includes('param')) {
    warnings.push(`WARN-TAGS ${exportedName} ${targetFile}:${lineOf(targetSource, docNode)} (missing @param)`);
  }
  if (returnsNonVoid(fn) && !tags.includes('returns') && !tags.includes('return')) {
    warnings.push(`WARN-TAGS ${exportedName} ${targetFile}:${lineOf(targetSource, docNode)} (missing @returns)`);
  }
}

for (const line of violations) console.log(line);
for (const line of warnings) console.log(line);

if (violations.length > 0) {
  console.log(`jsdoc coverage FAILED (${violations.length} missing, ${tasks.length} value exports checked)`);
  process.exit(1);
}
console.log(`jsdoc coverage OK (${tasks.length} value exports checked)`);
