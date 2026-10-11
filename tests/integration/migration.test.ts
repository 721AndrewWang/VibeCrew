// VibeCrew → Crew: a home folder laid out like the old app is migrated on the server's first start.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CrewServer, git, gitEnv, initRepo, startServer, tempDir } from '../helpers/server';

const root = tempDir('crew-migrate');
const HOME = path.join(root, 'home');
const oldData = path.join(HOME, '.vibecrew');
const oldSite = path.join(HOME, 'VibeCrewProjects', 'my-first-site');
const newSite = path.join(HOME, 'CrewProjects', 'my-first-site');
let crew: CrewServer;

beforeAll(async () => {
  fs.mkdirSync(oldData, { recursive: true });
  initRepo(oldSite, gitEnv(root), { 'index.html': '<h1>hi</h1>\n' });
  // What the old app wrote: settings keep the projects folder, projects.json the absolute path.
  fs.writeFileSync(path.join(oldData, 'settings.json'), JSON.stringify({ projectsRoot: path.join(HOME, 'VibeCrewProjects'), token: 'x', initialized: true, defaultPermission: 'ask' }));
  fs.writeFileSync(path.join(oldData, 'projects.json'), JSON.stringify([{ id: 'p_old1', name: 'My first site', path: oldSite, createdAt: 1, updatedAt: 1 }]));
  fs.writeFileSync(path.join(oldData, 'bots.json'), '[]');
  fs.writeFileSync(path.join(oldData, 'chats.json'), '[]');
  crew = await startServer({ isolate: false, dir: root, env: { HOME } });
});

afterAll(async () => {
  await crew?.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('first start after the rename', () => {
  it('identifies as crew', async () => {
    expect((await (await fetch(`${crew.base}/api/health`)).json()).app).toBe('crew');
  });
  it('moves the data folder to ~/.crew', () => {
    expect(fs.existsSync(path.join(HOME, '.crew', 'settings.json'))).toBe(true);
    expect(fs.existsSync(oldData)).toBe(false);
  });
  it('moves the projects folder to ~/CrewProjects', () => {
    expect(fs.existsSync(path.join(newSite, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(HOME, 'VibeCrewProjects'))).toBe(false);
  });
  it('keeps the settings and updates the saved paths', async () => {
    const b = await crew.api('GET', '/bootstrap');
    expect(b.settings.defaultPermission).toBe('ask');
    expect(b.settings.projectsRoot).toBe(path.join(HOME, 'CrewProjects'));
    expect(b.projects.find((p: any) => p.id === 'p_old1')?.path).toBe(newSite);
  });
  it('keeps the project a working git repository and the secrets as they were', () => {
    expect(git(newSite, gitEnv(root), 'log', '--oneline')).toContain('init');
    expect(JSON.parse(fs.readFileSync(path.join(HOME, '.crew', 'settings.json'), 'utf8')).token).toBe('x');
  });
});
