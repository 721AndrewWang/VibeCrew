// Prints one version's section of CHANGELOG.md (the release notes for that tag).
//   node desktop/release-notes.mjs 0.2.0
import fs from 'node:fs';

const version = process.argv[2];
if (!version) {
  console.error('usage: node desktop/release-notes.mjs <version>');
  process.exit(2);
}
const text = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const lines = text.split('\n');
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start < 0) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
if (end < 0) end = lines.findIndex((l, i) => i > start && /^\[[^\]]+\]: /.test(l));
if (end < 0) end = lines.length;
process.stdout.write(
  lines
    .slice(start + 1, end)
    .join('\n')
    .trim() + '\n',
);
