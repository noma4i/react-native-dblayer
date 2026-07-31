import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, '..');

const readOption = (args, name) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a path`);
  return value;
};

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const readTemplateSections = () => {
  const template = readFileSync(path.join(repoRoot, '.github/release-notes-template.md'), 'utf8');
  const sections = [...template.matchAll(/^### (.+)$/gm)].map(match => match[1]);
  if (sections.length === 0) throw new Error('Release notes template must declare at least one section');
  return sections;
};

export const extractReleaseNotes = (changelog, tag) => {
  const version = tag.replace(/^v/, '');
  const headingPattern = new RegExp(`^## ${escapeRegExp(version)} - \\d{4}-\\d{2}-\\d{2}$`, 'm');
  const heading = headingPattern.exec(changelog);
  if (!heading) throw new Error(`Changelog entry not found for ${tag}`);

  const start = heading.index;
  const nextHeading = changelog.indexOf('\n## ', start + heading[0].length);
  const notes = changelog.slice(start, nextHeading === -1 ? changelog.length : nextHeading).trimEnd();
  const templateSections = readTemplateSections();
  const sectionIndexes = [...notes.matchAll(/^### (.+)$/gm)].map(match => {
    const section = match[1];
    const index = templateSections.indexOf(section);
    if (index === -1) throw new Error(`Unsupported release notes section: ${section}`);
    return index;
  });

  if (sectionIndexes.length === 0) throw new Error(`Release notes for ${tag} must contain at least one section`);
  if (new Set(sectionIndexes).size !== sectionIndexes.length) throw new Error(`Release notes for ${tag} contain a duplicate section`);
  if (sectionIndexes.some((index, position) => position > 0 && index <= sectionIndexes[position - 1])) {
    throw new Error(`Release notes sections for ${tag} do not follow the template order`);
  }

  return `${notes}\n`;
};

const args = process.argv.slice(2);
const tag = args[0];

if (!tag || tag.startsWith('--')) {
  process.stderr.write('Usage: yarn release:notes <tag> [--changelog <path>]\n');
  process.exitCode = 1;
} else {
  try {
    const changelogPath = path.resolve(repoRoot, readOption(args, '--changelog') ?? 'CHANGELOG.md');
    const notes = extractReleaseNotes(readFileSync(changelogPath, 'utf8'), tag);
    const outputPath = readOption(args, '--output');
    if (outputPath) {
      writeFileSync(path.resolve(outputPath), notes);
    } else {
      process.stdout.write(notes);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
