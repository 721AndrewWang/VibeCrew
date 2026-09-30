// `npm run desktop`: runs the desktop app from source.
// Ubuntu 23.10+ blocks the user namespaces Chromium's sandbox needs for apps without an
// AppArmor profile, so from a normal terminal Electron must start with --no-sandbox.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureElectron } from './electron-bin.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const bin = ensureElectron();
const proc = spawn(bin, [root, '--no-sandbox', ...process.argv.slice(2)], { stdio: 'inherit' });
proc.on('exit', (code) => process.exit(code ?? 0));
