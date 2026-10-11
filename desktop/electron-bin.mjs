// Electron 44 downloads its binary on first use. Make sure it is there (set ELECTRON_MIRROR to use a mirror).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkgDir = path.join(root, 'node_modules', 'electron');

export function ensureElectron() {
  const pathFile = path.join(pkgDir, 'path.txt');
  const bin = fs.existsSync(pathFile) ? path.join(pkgDir, 'dist', fs.readFileSync(pathFile, 'utf8').trim()) : null;
  if (bin && fs.existsSync(bin)) return bin;
  console.log('Downloading Electron (first run)...');
  const r = spawnSync(process.execPath, [path.join(pkgDir, 'install.js')], {
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error('Electron download failed. Set ELECTRON_MIRROR to use a different mirror and try again.');
  return path.join(pkgDir, 'dist', fs.readFileSync(pathFile, 'utf8').trim());
}
