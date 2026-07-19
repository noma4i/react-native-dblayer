import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(__dirname, '../../../..');
const entry = path.join(root, 'src/index.ts');

const createExportSurface = () => {
  const program = ts.createProgram([entry], {
    strict: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  if (!source) throw new Error('public barrel source was not loaded');
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error('public barrel symbol was not resolved');
  return { checker, exports: checker.getExportsOfModule(moduleSymbol).sort((left, right) => left.name.localeCompare(right.name)) };
};

const resolveAlias = (checker: ts.TypeChecker, symbol: ts.Symbol) =>
  symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

const declarationPaths = (symbol: ts.Symbol | undefined) =>
  symbol?.declarations?.map(declaration => declaration.getSourceFile().fileName.split(path.sep).join('/')) ?? [];

describe('public declaration hygiene', () => {
  it('does not expose internal properties on exported types', () => {
    const { checker, exports } = createExportSurface();
    const leaks = exports.flatMap(exported => {
      const target = resolveAlias(checker, exported);
      if (!(target.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias))) return [];
      return checker
        .getPropertiesOfType(checker.getDeclaredTypeOfSymbol(target))
        .filter(member => member.name.startsWith('__') && (member.declarations?.length ?? 0) > 0)
        .map(member => `${exported.name}.${member.name}`);
    });

    expect(leaks).toEqual([]);
  });

  it('does not expose symbols owned by TanStack packages', () => {
    const { checker, exports } = createExportSurface();
    const leaks = exports.flatMap(exported => {
      const target = resolveAlias(checker, exported);
      const declaration = target.valueDeclaration ?? target.declarations?.[0];
      const type = declaration ? checker.getTypeOfSymbolAtLocation(target, declaration) : checker.getDeclaredTypeOfSymbol(target);
      const paths = [...declarationPaths(target), ...declarationPaths(type.aliasSymbol), ...declarationPaths(type.getSymbol())];
      return paths.some(file => file.includes('/node_modules/@tanstack/')) ? [exported.name] : [];
    });

    expect(leaks).toEqual([]);
  });
});
