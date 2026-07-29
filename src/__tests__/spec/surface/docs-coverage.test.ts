import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import * as barrel from '../../../index';

const root = path.resolve(__dirname, '../../../..');
const docsDir = path.join(root, 'docs');

const listMarkdownFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listMarkdownFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'CLAUDE.md' ? [entryPath] : [];
  });

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const publicDocFiles = (): string[] => [path.join(root, 'README.md'), ...listMarkdownFiles(docsDir)];

const exportReferenceRows = (): Array<{ name: string; kind: 'value' | 'type' }> => {
  const readme = fs.readFileSync(path.join(docsDir, 'README.md'), 'utf8');
  return [...readme.matchAll(/^\| `([A-Za-z0-9_]+)`\s*\| (value|type)\s*\|/gm)].map(match => ({ name: match[1]!, kind: match[2] as 'value' | 'type' }));
};

const sourceFile = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const publicTypeExports = (): string[] => {
  const indexSource = sourceFile(path.join(root, 'src/index.ts'));
  return indexSource.statements
    .flatMap(statement =>
      ts.isExportDeclaration(statement) && statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.map(element => element.name.text)
        : []
    )
    .sort((left, right) => left.localeCompare(right));
};

const typeLiteralMembers = (file: string, typeName: string): string[] => {
  const source = sourceFile(file);
  const declaration = source.statements.find(
    (statement): statement is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName
  );
  if (!declaration || !ts.isTypeLiteralNode(declaration.type)) throw new Error(`Missing type literal ${typeName}`);
  return declaration.type.members.flatMap(member => {
    if (!member.name) return [];
    if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) return [member.name.text];
    return [member.name.getText(source)];
  });
};

const declaredTypeMembers = (file: string, typeName: string): string[] => {
  const source = sourceFile(file);
  const declarations = new Map(
    source.statements.flatMap(statement =>
      (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) ? [[statement.name.text, statement] as const] : []
    )
  );
  const memberNames = (members: ts.NodeArray<ts.TypeElement>): string[] =>
    members.flatMap(member => {
      if (!member.name) return [];
      if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) return [member.name.text];
      return [member.name.getText(source)];
    });
  const visitType = (node: ts.TypeNode): string[] => {
    if (ts.isTypeLiteralNode(node)) return memberNames(node.members);
    if (ts.isIntersectionTypeNode(node) || ts.isUnionTypeNode(node)) return node.types.flatMap(visitType);
    if (ts.isParenthesizedTypeNode(node)) return visitType(node.type);
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      const referenced = declarations.get(node.typeName.text);
      if (referenced && ts.isTypeAliasDeclaration(referenced)) return visitType(referenced.type);
      if (referenced && ts.isInterfaceDeclaration(referenced)) return memberNames(referenced.members);
    }
    return [];
  };
  const declaration = declarations.get(typeName);
  if (declaration && ts.isTypeAliasDeclaration(declaration)) return [...new Set(visitType(declaration.type))].sort();
  if (declaration && ts.isInterfaceDeclaration(declaration)) return [...new Set(memberNames(declaration.members))].sort();
  throw new Error(`Missing declaration ${typeName}`);
};

const optionTableRows = (file: string, heading: string): string[] => {
  const text = fs.readFileSync(file, 'utf8');
  const headingPattern = new RegExp(`^#{2,6} ${escapeRegExp(heading)}$`, 'm');
  const headingMatch = headingPattern.exec(text);
  if (!headingMatch) throw new Error(`Missing heading ${heading}`);
  const sectionStart = headingMatch.index + headingMatch[0].length;
  const rest = text.slice(sectionStart);
  const nextHeading = /^#{2,6} /m.exec(rest);
  const section = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  return [...section.matchAll(/^\| `([^`]+)`\s*\|/gm)]
    .map(match => match[1]!)
    .filter(name => !name.includes('.'))
    .sort();
};

const publicDocsText = (): string => publicDocFiles().map(file => fs.readFileSync(file, 'utf8')).join('\n');

const typedCodeBlocks = (markdown: string): string[] => [...markdown.matchAll(/```(?:tsx|jsx)\n([\s\S]*?)```/g)].map(match => match[1]!);

const markdownAnchors = (file: string): Set<string> => {
  const counts = new Map<string, number>();
  const anchors = new Set<string>();
  for (const match of fs.readFileSync(file, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = match[1]!
      .trim()
      .toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/[`*_~]/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-');
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
};

describe('docs coverage gate', () => {
  it('documents every runtime barrel export at least once across docs/**/*.md', () => {
    const docsText = publicDocsText();
    const exportNames = Object.keys(barrel).sort((left, right) => left.localeCompare(right));
    const missing = exportNames.filter(name => !new RegExp(`\\b${escapeRegExp(name)}\\b`).test(docsText));

    expect(missing).toEqual([]);
  });

  it('lists exactly the runtime barrel surface as value rows in the export reference', () => {
    const documentedValues = exportReferenceRows()
      .filter(row => row.kind === 'value')
      .map(row => row.name)
      .sort((left, right) => left.localeCompare(right));
    const barrelValues = Object.keys(barrel).sort((left, right) => left.localeCompare(right));

    expect(documentedValues).toEqual(barrelValues);
  });

  it('lists exactly the public type barrel surface as type rows in the export reference', () => {
    const documentedTypes = exportReferenceRows()
      .filter(row => row.kind === 'type')
      .map(row => row.name)
      .sort((left, right) => left.localeCompare(right));

    expect(documentedTypes).toEqual(publicTypeExports());
  });

  it('references only actual ModelCore members in public docs', () => {
    const modelMembers = new Set(typeLiteralMembers(path.join(root, 'src/types/dsl.model.types.ts'), 'ModelCore'));
    const referencedMembers = [...publicDocsText().matchAll(/\bModel\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(match => match[1]!);

    expect([...new Set(referencedMembers.filter(member => !modelMembers.has(member)))].sort()).toEqual([]);
  });

  it('uses only declared DbProvider props in public TSX examples', () => {
    const declaredProps = new Set(typeLiteralMembers(path.join(root, 'src/types/dsl.dbProvider.types.ts'), 'DbProviderProps'));
    const exampleProps = publicDocFiles().flatMap(file =>
      typedCodeBlocks(fs.readFileSync(file, 'utf8')).flatMap((block, blockIndex) => {
        const source = ts.createSourceFile(`${file}:${blockIndex}.tsx`, block, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const props: string[] = [];
        const visit = (node: ts.Node): void => {
          if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === 'DbProvider') {
            for (const attribute of node.attributes.properties) {
              if (ts.isJsxAttribute(attribute)) props.push(attribute.name.getText(source));
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
        return props;
      })
    );

    expect([...new Set(exampleProps.filter(prop => !declaredProps.has(prop)))].sort()).toEqual([]);
  });

  it.each([
    {
      doc: 'getting-started.md',
      heading: '`configureDb(options)`',
      source: 'src/types/dsl.configure.types.ts',
      type: 'ConfigureDbOptions',
      extra: []
    },
    {
      doc: 'getting-started.md',
      heading: '`DbDefaults`',
      source: 'src/types/dsl.configure.types.ts',
      type: 'DbDefaults',
      extra: []
    },
    {
      doc: 'queries.md',
      heading: '`QueryConfig`',
      source: 'src/types/dsl.query.types.ts',
      type: 'QueryConfig',
      extra: ['live']
    },
    {
      doc: 'queries.md',
      heading: '`FetchConfig`',
      source: 'src/types/dsl.fetch.types.ts',
      type: 'FetchConfig',
      extra: []
    },
    {
      doc: 'models.md',
      heading: '`ModelConfig`',
      source: 'src/types/dsl.model.types.ts',
      type: 'ModelConfig',
      extra: []
    },
    {
      doc: 'models.md',
      heading: '`ScopeSpec`',
      source: 'src/types/dsl.scope.types.ts',
      type: 'ScopeSpec',
      extra: []
    },
    {
      doc: 'mutations.md',
      heading: '`MutationConfig`',
      source: 'src/types/dsl.mutation.types.ts',
      type: 'MutationConfig',
      extra: []
    },
    {
      doc: 'reading.md',
      heading: '`Model.view(name, config)`',
      source: 'src/types/dsl.view.types.ts',
      type: 'ViewConfig',
      extra: []
    }
  ])('keeps $heading option rows equal to $type properties', ({ doc, heading, source, type, extra }) => {
    const expected = [...new Set([...declaredTypeMembers(path.join(root, source), type), ...extra])].sort();

    expect(optionTableRows(path.join(docsDir, doc), heading)).toEqual(expected);
  });

  it('keeps every local public-doc link and anchor resolvable', () => {
    const failures: string[] = [];
    for (const file of publicDocFiles()) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/\[[^\]]*]\(([^)]+)\)/g)) {
        const href = match[1]!;
        if (/^(?:https?:|mailto:)/.test(href)) continue;
        const [relativeTarget, rawAnchor] = href.split('#');
        const target = relativeTarget ? path.resolve(path.dirname(file), relativeTarget) : file;
        if (!fs.existsSync(target)) {
          failures.push(`${path.relative(root, file)} -> ${href}: missing file`);
          continue;
        }
        if (rawAnchor && !markdownAnchors(target).has(decodeURIComponent(rawAnchor))) {
          failures.push(`${path.relative(root, file)} -> ${href}: missing anchor`);
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
