// A fake `gh` for tests (ADR 102): put its folder first on the server's PATH and it answers
// `gh api` GETs from JSON files, logs every call, and answers the commands approved drafts run with
// a URL. Nothing touches the network.
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './server';

export interface FakeGh {
  /** The folder holding the `gh` script: prepend it to PATH. */
  bin: string;
  /** PATH with the fake first, for startServer's env. */
  path: string;
  /** The answer to `gh api <apiPath>` (the part before `?`); unset paths answer `[]`. */
  respond(apiPath: string, json: unknown): void;
  /** What a draft's command prints (its URL). */
  postUrl(url: string): void;
  /** Every call so far, as argv. */
  calls(): string[][];
  /** A failing `gh api` for this path: it prints `message` and exits 1. */
  fail(apiPath: string, message: string): void;
  remove(): void;
}

const fileFor = (apiPath: string) => `${apiPath.split('?')[0].replace(/[^\w.-]+/g, '__')}.json`;

const SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const valued = new Set(['--method', '-X', '-H', '--header', '-f', '-F', '--raw-field', '--field', '--jq', '-q', '--body', '--repo', '-R', '--title']);
if (args[0] === 'api') {
  let method = 'GET';
  let target = '';
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--method' || args[i] === '-X') method = args[i + 1];
    if (valued.has(args[i])) { i++; continue; }
    if (!args[i].startsWith('-')) target = args[i];
  }
  const name = target.split('?')[0].replace(/[^\\w.-]+/g, '__') + '.json';
  if (method !== 'GET') { process.stdout.write(fs.readFileSync(path.join(dir, 'post-url.txt'), 'utf8')); process.exit(0); }
  const failFile = path.join(dir, 'fail-' + name);
  if (fs.existsSync(failFile)) { process.stderr.write(fs.readFileSync(failFile, 'utf8')); process.exit(1); }
  const file = path.join(dir, name);
  process.stdout.write(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '[]');
  process.exit(0);
}
if ((args[0] === 'issue' || args[0] === 'pr') && args[1] === 'comment') { process.stdout.write(fs.readFileSync(path.join(dir, 'post-url.txt'), 'utf8') + '\\n'); process.exit(0); }
process.stderr.write('fake gh: unsupported command ' + args.join(' '));
process.exit(1);
`;

export function fakeGh(): FakeGh {
  const bin = tempDir('crew-fake-gh');
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\n${SCRIPT}`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'post-url.txt'), 'https://github.com/acme/shop/issues/1#issuecomment-1');
  return {
    bin,
    path: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    respond: (apiPath, json) => {
      fs.rmSync(path.join(bin, `fail-${fileFor(apiPath)}`), { force: true });
      fs.writeFileSync(path.join(bin, fileFor(apiPath)), JSON.stringify(json));
    },
    fail: (apiPath, message) => fs.writeFileSync(path.join(bin, `fail-${fileFor(apiPath)}`), message),
    postUrl: (url) => fs.writeFileSync(path.join(bin, 'post-url.txt'), url),
    calls: () => {
      const f = path.join(bin, 'calls.jsonl');
      return fs.existsSync(f)
        ? fs
            .readFileSync(f, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [];
    },
    remove: () => fs.rmSync(bin, { recursive: true, force: true }),
  };
}
