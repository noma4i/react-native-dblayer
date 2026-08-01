import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const srcRoot = path.resolve(__dirname, '../../..');

/**
 * The lexical acceptance gates of the principles spec, executable. A gate that lives only as a
 * command in a document is a gate nobody runs: it drifts until the day it is needed and then
 * reports a violation that was introduced months earlier.
 */
const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(target);
    return /\.tsx?$/.test(entry.name) ? [target] : [];
  });

const relative = (file: string): string => path.relative(srcRoot, file);

/** One walk and one read of the tree for all four gates: a gate pays for itself out of the shard budget. */
const sources: Array<{ file: string; text: string; lines: string[] }> = sourceFiles(srcRoot).map(file => {
  const text = fs.readFileSync(file, 'utf8');
  return { file, text, lines: text.split('\n') };
});

const matchingLines = (pattern: RegExp): string[] =>
  sources.flatMap(({ file, lines }) => lines.flatMap((text, index) => (pattern.test(text) ? [`${relative(file)}:${index + 1}`] : [])));

/**
 * Domain words are hunted in identifiers and string literals, not in prose. A comment sentence that
 * happens to contain an English word carries no domain into the core, while an identifier or a
 * literal does - so the narrower scan is the one that matches the subject.
 *
 * `message` is deliberately absent from the list: this package names sync messages and error
 * messages with it, so including it would fail on code that carries no domain at all.
 */
const DOMAIN_WORDS = ['media', 'chat', 'moment', 'vibe', 'gift', 'avatar', 'photo', 'video'];

/** Domain leakage arrives as a name SEGMENT (`chatBucket`, `videoId`), so segments are what gets compared. */
const segmentsOf = (text: string): string[] =>
  text
    .split(/[^A-Za-z]+/)
    .flatMap(part => part.split(/(?=[A-Z])/))
    .map(part => part.toLowerCase())
    .filter(part => part.length > 0);

const carriesDomain = (text: string): boolean => segmentsOf(text).some(segment => DOMAIN_WORDS.includes(segment));

const domainNames = ({ file, text }: { file: string; text: string }): string[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const name = ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
    if (name !== undefined && carriesDomain(name)) {
      found.push(`${relative(file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${name}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

describe('source hygiene', () => {
  it('writes production source in English only', () => {
    expect(matchingLines(/[Ѐ-ӿ]/)).toEqual([]);
  });

  it('uses the plain hyphen and no section sign', () => {
    expect(matchingLines(/[‐‑–—―−§]/)).toEqual([]);
  });

  it('leaves no temporary markers behind', () => {
    expect(matchingLines(/TEMPORARY|TODO|FIXME/)).toEqual([]);
  });

  it('keeps domain vocabulary out of identifiers and literals', () => {
    expect(sources.flatMap(domainNames)).toEqual([]);
  });
});
