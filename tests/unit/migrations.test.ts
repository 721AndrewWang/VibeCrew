import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Migration, migrate, NewerDataError, SCHEMA_VERSION } from '../../server/migrations';
import { tempDir } from '../helpers/server';

const settingsOf = (home: string) => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
const home = (settings?: object) => {
  const dir = tempDir('crew-migrate');
  if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  return dir;
};
const steps = (ran: string[]): Migration[] => [
  { version: 2, title: 'two', run: (h) => ran.push(`2:${fs.readdirSync(h).includes('backups')}`) },
  { version: 1, title: 'one', run: () => ran.push('1') },
  { version: 3, title: 'three', run: () => ran.push('3') },
];

describe('migrate', () => {
  it('leaves a fresh folder alone; the first save stamps it', () => {
    const h = home();
    expect(migrate(h)).toEqual([]);
    expect(fs.existsSync(path.join(h, 'settings.json'))).toBe(false);
  });
  it('runs the newer migrations in order, after a backup, stamping each one', () => {
    const ran: string[] = [];
    const h = home({ token: 'x', schemaVersion: 1 });
    const done = migrate(h, steps(ran), 3);
    expect(done.map((m) => m.version)).toEqual([2, 3]);
    expect(ran).toEqual(['2:true', '3']);
    expect(settingsOf(h)).toEqual({ token: 'x', schemaVersion: 3 });
    const backups = fs.readdirSync(path.join(h, 'backups'));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(h, 'backups', backups[0], 'settings.json'), 'utf8')).schemaVersion).toBe(1);
  });
  it('treats a folder without a version as version 0', () => {
    const ran: string[] = [];
    const h = home({ token: 'x' });
    expect(migrate(h, steps(ran), 3).map((m) => m.version)).toEqual([1, 2, 3]);
    expect(settingsOf(h).schemaVersion).toBe(3);
  });
  it('does nothing twice', () => {
    const ran: string[] = [];
    const h = home({ schemaVersion: 3 });
    expect(migrate(h, steps(ran), 3)).toEqual([]);
    expect(ran).toEqual([]);
    expect(fs.existsSync(path.join(h, 'backups'))).toBe(false);
  });
  it('refuses a folder written by a newer Crew', () => {
    expect(() => migrate(home({ schemaVersion: SCHEMA_VERSION + 1 }))).toThrow(NewerDataError);
  });
});
