import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config';
import { uid } from './store';

const EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export const IMAGE_MIMES = new Set(Object.keys(EXT));

export function saveUpload(buf: Buffer, mime: string, name = 'image') {
  const ext = EXT[mime] || '.bin';
  const id = uid('u_');
  fs.writeFileSync(path.join(DATA.uploads, id + ext), buf);
  return { id, name, mime, url: `/api/uploads/${id}${ext}` };
}

/** Absolute path of an upload file name, or null when the name is not a plain upload. */
export function uploadFile(fileName: string): string | null {
  if (!/^u_[\w]+\.(png|jpg|gif|webp|bin)$/.test(fileName)) return null;
  const abs = path.join(DATA.uploads, fileName);
  return fs.existsSync(abs) ? abs : null;
}

export function readUpload(url: string): { data: string; mime: string } | null {
  const file = uploadFile(path.basename(url));
  if (!file) return null;
  const ext = path.extname(file);
  const mime = Object.entries(EXT).find(([, e]) => e === ext)?.[0];
  if (!mime) return null;
  return { data: fs.readFileSync(file).toString('base64'), mime };
}
