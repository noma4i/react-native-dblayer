import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const srcRoot = path.resolve(__dirname, '../../..');
const landingFiles = [
  { relative: 'dsl/facadeActions.ts', transportMethods: ['mutation', 'query'] },
  { relative: 'dsl/defineQuery.ts', transportMethods: ['query'] },
  { relative: 'core/modelEventRegistry.ts', transportMethods: null }
] as const;

const parse = (relative: string): ts.SourceFile => {
  const file = path.join(srcRoot, relative);
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
};

const propertyName = (node: ts.PropertyName | ts.BindingName | undefined): string | null => {
  if (node && (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node))) return node.text;
  return null;
};

const nodesOf = <TNode extends ts.Node>(source: ts.Node, predicate: (node: ts.Node) => node is TNode): TNode[] => {
  const matches: TNode[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return matches;
};

const containsIdentifier = (node: ts.Node, name: string): boolean =>
  nodesOf(node, (candidate): candidate is ts.Identifier => ts.isIdentifier(candidate) && candidate.text === name).length > 0;

const typeAlias = (source: ts.SourceFile, name: string): ts.TypeAliasDeclaration => {
  const declarations = nodesOf(source, (node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === name);
  expect(declarations).toHaveLength(1);
  return declarations[0]!;
};

const directMember = (alias: ts.TypeAliasDeclaration, name: string): ts.TypeElement => {
  expect(ts.isTypeLiteralNode(alias.type)).toBe(true);
  const members = (alias.type as ts.TypeLiteralNode).members.filter(member => propertyName(member.name) === name);
  expect(members).toHaveLength(1);
  return members[0]!;
};

const parametersOf = (member: ts.TypeElement): ts.NodeArray<ts.ParameterDeclaration> => {
  if (ts.isMethodSignature(member)) return member.parameters;
  if (ts.isPropertySignature(member) && member.type && ts.isFunctionTypeNode(member.type)) return member.type.parameters;
  throw new Error(`Expected a callable type member, received ${ts.SyntaxKind[member.kind]}`);
};

const unionMembers = (alias: ts.TypeAliasDeclaration): ts.TypeLiteralNode[] => {
  const members = ts.isUnionTypeNode(alias.type) ? alias.type.types : [alias.type];
  expect(members.every(ts.isTypeLiteralNode)).toBe(true);
  return members as ts.TypeLiteralNode[];
};

const discriminant = (member: ts.TypeLiteralNode): string => {
  const kind = member.members.find(candidate => propertyName(candidate.name) === 'kind');
  expect(kind && ts.isPropertySignature(kind) && kind.type && ts.isLiteralTypeNode(kind.type) && ts.isStringLiteral(kind.type.literal)).toBe(true);
  return ((kind as ts.PropertySignature).type as ts.LiteralTypeNode).literal.getText().slice(1, -1);
};

const property = (member: ts.TypeLiteralNode, name: string): ts.PropertySignature | undefined => {
  const matches = member.members.filter(candidate => ts.isPropertySignature(candidate) && propertyName(candidate.name) === name) as ts.PropertySignature[];
  expect(matches.length).toBeLessThanOrEqual(1);
  return matches[0];
};

const callExpressions = (source: ts.Node, memberName: string): ts.CallExpression[] =>
  nodesOf(
    source,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === memberName
  );

const functionVariable = (source: ts.SourceFile, name: string): ts.ArrowFunction | ts.FunctionExpression => {
  const declarations = nodesOf(
    source,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && propertyName(node.name) === name && !!node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  );
  expect(declarations).toHaveLength(1);
  return declarations[0]!.initializer as ts.ArrowFunction | ts.FunctionExpression;
};

describe('causal write discipline', () => {
  it('captures one base revision at each async landing and forwards it through the shared causal compiler', () => {
    for (const landing of landingFiles) {
      const source = parse(landing.relative);
      const captures = nodesOf(
        source,
        (node): node is ts.CallExpression =>
          ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'currentEpoch'
      );
      expect(captures.length).toBeGreaterThan(0);
      expect(nodesOf(source, (node): node is ts.Identifier => ts.isIdentifier(node) && node.text === 'baseRevision').length).toBeGreaterThan(1);

      const forwarded = nodesOf(
        source,
        (node): node is ts.CallExpression =>
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'stampCausalRevision' &&
          node.arguments.some(argument => containsIdentifier(argument, 'baseRevision'))
      );
      expect(forwarded.length).toBeGreaterThan(0);

      if (landing.transportMethods) {
        const transportCalls = landing.transportMethods.flatMap(method => callExpressions(source, method)).filter(call =>
          ts.isPropertyAccessExpression(call.expression) ? /transport/i.test(call.expression.expression.getText(source)) : false
        );
        expect(transportCalls.length).toBeGreaterThan(0);
        for (const call of transportCalls) {
          let owner: ts.Node | undefined = call.parent;
          while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
          expect(owner).toBeDefined();
          const localCaptures = nodesOf(
            owner!,
            (node): node is ts.CallExpression =>
              ts.isCallExpression(node) &&
              ts.isPropertyAccessExpression(node.expression) &&
              node.expression.name.text === 'currentEpoch' &&
              node.getStart(source) < call.getStart(source)
          );
          expect(localCaptures.length).toBeGreaterThan(0);
        }
      } else {
        const onData = nodesOf(
          source,
          (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && propertyName(node.name) === 'onData'
        );
        expect(onData).toHaveLength(1);
        expect(containsIdentifier(onData[0]!, 'baseRevision')).toBe(true);
        const deliveryCalls = nodesOf(
          onData[0]!,
          (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            ((ts.isIdentifier(node.expression) && node.expression.text === 'deliver') ||
              (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'deliver'))
        );
        expect(deliveryCalls).toHaveLength(1);
        expect(captures.some(capture => capture.getStart(source) < deliveryCalls[0]!.getStart(source))).toBe(true);
      }

      const localHelpers = nodesOf(source, (node): node is ts.NamedDeclaration => {
        if (
          !ts.isFunctionDeclaration(node) &&
          !ts.isClassDeclaration(node) &&
          !ts.isInterfaceDeclaration(node) &&
          !ts.isTypeAliasDeclaration(node) &&
          !ts.isVariableDeclaration(node)
        ) {
          return false;
        }
        const name = propertyName(node.name);
        if (!name || name === 'baseRevision' || !/(?:causal|admission|revision)/i.test(name)) return false;
        return !ts.isVariableDeclaration(node) || (!!node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)));
      });
      expect(localHelpers).toEqual([]);
    }
  });

  it('keeps optional causal metadata only on raw entity WriteOp variants', () => {
    const source = parse('types/core.apply.journal.types.ts');
    const writeMembers = unionMembers(typeAlias(source, 'WriteOp'));
    const causalKinds = new Set(['upsert', 'patch', 'destroy']);

    for (const member of writeMembers) {
      const kind = discriminant(member);
      const baseRevision = property(member, 'baseRevision');
      if (causalKinds.has(kind)) {
        expect(baseRevision).toBeDefined();
        expect(baseRevision!.questionToken).toBeDefined();
        expect(baseRevision!.type?.kind).toBe(ts.SyntaxKind.NumberKeyword);
      } else {
        expect(baseRevision).toBeUndefined();
      }
    }
    expect(new Set(writeMembers.filter(member => property(member, 'baseRevision')).map(discriminant))).toEqual(causalKinds);

    const journal = typeAlias(source, 'JournalOp');
    const persistedCausalFields = nodesOf(
      journal,
      (node): node is ts.PropertySignature =>
        ts.isPropertySignature(node) && /^(?:base|commit)Revision$/.test(propertyName(node.name) ?? '')
    );
    expect(persistedCausalFields).toEqual([]);
  });

  it('passes the journal commit epoch through the transaction into every apply target', () => {
    const targetSource = parse('types/core.apply.transaction.types.ts');
    const beginApply = directMember(typeAlias(targetSource, 'ApplyTarget'), 'beginApply');
    const targetParameters = parametersOf(beginApply);
    expect(targetParameters).toHaveLength(1);
    expect(targetParameters[0]!.type?.kind).toBe(ts.SyntaxKind.NumberKeyword);

    const applySource = parse('core/apply/applyExecution.ts');
    const applyAtomically = functionVariable(applySource, 'applyAtomically');
    expect(applyAtomically.parameters).toHaveLength(3);
    expect(applyAtomically.parameters[1]!.type?.kind).toBe(ts.SyntaxKind.NumberKeyword);
    const commitEpochName = propertyName(applyAtomically.parameters[1]!.name);
    expect(commitEpochName).not.toBeNull();
    const beginCalls = callExpressions(applyAtomically, 'beginApply');
    expect(beginCalls.length).toBeGreaterThan(0);
    for (const call of beginCalls) {
      expect(call.arguments).toHaveLength(1);
      expect(containsIdentifier(call.arguments[0]!, commitEpochName!)).toBe(true);
    }

    const transactionSource = parse('core/apply/transaction.ts');
    const applyCalls = nodesOf(
      transactionSource,
      (node): node is ts.CallExpression => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'applyAtomically'
    );
    expect(applyCalls.length).toBeGreaterThan(0);
    for (const call of applyCalls) {
      expect(call.arguments).toHaveLength(3);
      expect(ts.isPropertyAccessExpression(call.arguments[1]!) && call.arguments[1]!.name.text === 'epoch').toBe(true);
    }
  });

  it('exposes one model-context revision owner and clears it through model reset', () => {
    const typeSource = parse('types/dsl.modelContext.types.ts');
    const context = typeAlias(typeSource, 'ModelContext');
    expect(ts.isTypeLiteralNode(context.type)).toBe(true);
    const owners = (context.type as ts.TypeLiteralNode).members.filter(
      member => ts.isPropertySignature(member) && /revision/i.test(propertyName(member.name) ?? '')
    ) as ts.PropertySignature[];
    expect(owners).toHaveLength(1);
    const ownerName = propertyName(owners[0]!.name)!;

    const implementation = parse('dsl/modelContext.ts');
    const ownerBindings = nodesOf(
      implementation,
      (node): node is ts.ObjectLiteralElementLike =>
        (ts.isShorthandPropertyAssignment(node) && node.name.text === ownerName) || (ts.isPropertyAssignment(node) && propertyName(node.name) === ownerName)
    );
    expect(ownerBindings).toHaveLength(1);
    const ownerBinding = ownerBindings[0]!;
    const runtimeOwnerName = ts.isShorthandPropertyAssignment(ownerBinding)
      ? ownerBinding.name.text
      : ts.isPropertyAssignment(ownerBinding) && ts.isIdentifier(ownerBinding.initializer)
        ? ownerBinding.initializer.text
        : null;
    expect(runtimeOwnerName).not.toBeNull();

    const resets = nodesOf(
      implementation,
      (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && propertyName(node.name) === 'reset'
    );
    const ownerResets = resets.filter(reset =>
      [...callExpressions(reset, 'reset'), ...callExpressions(reset, 'clear')].some(call =>
        ts.isPropertyAccessExpression(call.expression) ? containsIdentifier(call.expression.expression, runtimeOwnerName!) : false
      )
    );
    expect(ownerResets).toHaveLength(1);
    const ownerResetCalls = callExpressions(ownerResets[0]!, 'reset').filter(call =>
      ts.isPropertyAccessExpression(call.expression) ? containsIdentifier(call.expression.expression, runtimeOwnerName!) : false
    );
    const ownerClearCalls = callExpressions(ownerResets[0]!, 'clear').filter(call =>
      ts.isPropertyAccessExpression(call.expression) ? containsIdentifier(call.expression.expression, runtimeOwnerName!) : false
    );
    expect(ownerResetCalls.length + ownerClearCalls.length).toBe(1);
  });
});
