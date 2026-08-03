import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';

const sourceRoot = resolve(process.cwd(), 'src');

type SourceEntry = {
  name: string;
  source: string;
  file: ts.SourceFile;
};

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(file);
    return /\.tsx?$/.test(entry.name) ? [file] : [];
  });

const createSourceEntry = (file: string): SourceEntry => {
  const name = relative(sourceRoot, file);
  const source = readFileSync(file, 'utf8');
  return {
    name,
    source,
    file: ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  };
};

const sourceEntries = sourceFiles(sourceRoot).map(createSourceEntry);
const entryByName = new Map(sourceEntries.map(entry => [entry.name, entry]));

const sourceEntry = (name: string): SourceEntry => {
  const entry = entryByName.get(name);
  if (!entry) throw new Error(`Missing source entry: ${name}`);
  return entry;
};

const visit = (node: ts.Node, callback: (candidate: ts.Node) => void): void => {
  callback(node);
  ts.forEachChild(node, child => visit(child, callback));
};

const declarationName = (node: ts.Node): string | undefined => {
  if (
    ts.isTypeAliasDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return node.name?.text;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  return undefined;
};

const namedDeclarations = (entry: SourceEntry, name: string): ts.Node[] => {
  const declarations: ts.Node[] = [];
  visit(entry.file, node => {
    if (declarationName(node) === name) declarations.push(node);
  });
  return declarations;
};

const typeLiteralFor = (entry: SourceEntry, name: string): ts.TypeLiteralNode => {
  const declaration = namedDeclarations(entry, name)[0];
  if (!declaration || !ts.isTypeAliasDeclaration(declaration) || !ts.isTypeLiteralNode(declaration.type)) {
    throw new Error(`${entry.name}:${name} must be a type literal`);
  }
  return declaration.type;
};

const propertyName = (property: ts.TypeElement): string | undefined => {
  if (!('name' in property) || !property.name) return undefined;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
  return undefined;
};

const property = (type: ts.TypeLiteralNode, name: string): ts.PropertySignature => {
  const member = type.members.find(candidate => propertyName(candidate) === name);
  if (!member || !ts.isPropertySignature(member)) throw new Error(`Missing property: ${name}`);
  return member;
};

const exportedNames = (entry: SourceEntry): string[] => {
  const names: string[] = [];
  for (const statement of entry.file.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) names.push(element.name.text);
  }
  return names;
};

const callsIdentifier = (entry: SourceEntry, name: string): boolean => {
  let called = false;
  visit(entry.file, node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) called = true;
  });
  return called;
};

const directRootSelectorCalls = (entry: SourceEntry): string[] => {
  const calls: string[] = [];
  visit(entry.file, node => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'select') return;
    const operation = node.expression.expression;
    if (!ts.isPropertyAccessExpression(operation)) return;
    const root = operation.expression;
    if (!ts.isPropertyAccessExpression(root) || root.name.text !== 'root') return;
    if (!['insert', 'update', 'destroy'].includes(operation.name.text)) return;
    calls.push(node.getText(entry.file));
  });
  return calls;
};

const importsIdentifierFrom = (entry: SourceEntry, name: string, moduleName: string): boolean =>
  entry.file.statements.some(statement => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== moduleName) return false;
    const bindings = statement.importClause?.namedBindings;
    return bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.some(element => element.name.text === name);
  });

const propertyNamesIn = (entry: SourceEntry, declarationPattern: RegExp): string[] => {
  const names: string[] = [];
  visit(entry.file, node => {
    if (!declarationPattern.test(declarationName(node) ?? '')) return;
    visit(node, candidate => {
      if (ts.isPropertySignature(candidate) || ts.isMethodSignature(candidate)) {
        const name = propertyName(candidate);
        if (name) names.push(name);
      }
    });
  });
  return names;
};

const exactErrorSources = (message: string): Array<{ name: string; throws: number }> =>
  sourceEntries.flatMap(entry => {
    let strings = 0;
    let throws = 0;
    visit(entry.file, node => {
      if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return;
      if (node.text !== message) return;
      strings += 1;
      if (node.parent && ts.isNewExpression(node.parent) && node.parent.parent && ts.isThrowStatement(node.parent.parent)) throws += 1;
    });
    return strings === 0 ? [] : [{ name: entry.name, throws }];
  });

describe('model root discipline', () => {
  it('keeps GraphQL declarations configuration-only and owner-bound', () => {
    const publicBarrel = sourceEntry('index.ts');
    const modelTypes = sourceEntry('types/dsl.modelFacade.types.ts');
    const facadeConfig = typeLiteralFor(modelTypes, 'ModelFacadeConfig');
    const facadeCore = typeLiteralFor(modelTypes, 'ModelFacadeCore');

    expect(exportedNames(publicBarrel)).not.toContain('gql');
    expect(facadeCore.members.map(propertyName)).not.toContain('gql');
    for (const name of ['relations', 'actions', 'events']) {
      expect(property(facadeConfig, name).type?.kind).toBe(ts.SyntaxKind.FunctionType);
    }
  });

  it('routes action, live and query landing through the only root compiler', () => {
    const declarations = sourceEntries.flatMap(entry =>
      namedDeclarations(entry, 'ModelRootPlan').map(() => entry.name)
    );
    const compilers = sourceEntries.flatMap(entry =>
      namedDeclarations(entry, 'compileModelRootPlan').map(() => entry.name)
    );
    const action = sourceEntry('dsl/facadeActions.ts');
    const live = sourceEntry('core/modelEventRegistry.ts');
    const query = sourceEntry('dsl/defineQuery.ts');

    expect(declarations).toEqual(['types/dsl.modelRoot.types.ts']);
    expect(compilers).toEqual(['dsl/modelRootPlan.ts']);
    expect(importsIdentifierFrom(action, 'compileModelRootPlan', './modelRootPlan')).toBe(true);
    expect(importsIdentifierFrom(live, 'compileModelRootPlan', '../dsl/modelRootPlan')).toBe(true);
    expect(importsIdentifierFrom(query, 'compileModelRootPlan', './modelRootPlan')).toBe(true);
    expect(callsIdentifier(action, 'compileModelRootPlan')).toBe(true);
    expect(callsIdentifier(live, 'compileModelRootPlan')).toBe(true);
    expect(callsIdentifier(query, 'compileModelRootPlan')).toBe(true);
  });

  it('keeps action root selectors behind the root compiler', () => {
    expect(directRootSelectorCalls(sourceEntry('dsl/facadeActions.ts'))).toEqual([]);
  });

  it('keeps owner exclusion in the only WritePlan compiler', () => {
    expect(exactErrorSources('WritePlan cannot target its owner model')).toEqual([
      { name: 'dsl/writePlan.ts', throws: 1 }
    ]);
  });

  it('removes action and live landing alternatives by property name', () => {
    const modelTypes = sourceEntry('types/dsl.modelFacade.types.ts');
    const actionProperties = propertyNamesIn(modelTypes, /^(?:GraphqlAction|InsertAction|UpdateAction|DestroyAction|CustomAction)/);
    const liveProperties = propertyNamesIn(modelTypes, /^GraphqlLive/);

    expect(actionProperties).not.toContain('kind');
    expect(actionProperties).not.toContain('select');
    expect(liveProperties).not.toContain('handler');
  });
});
