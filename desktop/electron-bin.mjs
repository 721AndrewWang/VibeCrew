// Electron 44 downloads its binary on first use. Make sure it is there, through a fast mirror.
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
  console.log('正在下载 Electron（首次运行）…');
  const r = spawnSync(process.execPath, [path.join(pkgDir, 'install.js')], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/' },
  });
  if (r.status !== 0) throw new Error('Electron 下载失败，可以设置 ELECTRON_MIRROR 换一个镜像后重试');
  return path.join(pkgDir, 'dist', fs.readFileSync(pathFile, 'utf8').trim());
}
