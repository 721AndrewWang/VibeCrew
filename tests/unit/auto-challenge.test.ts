import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { autoChallengeReasons, defaultAutoChallenge, parseNumstat, resetAutoChallenge, ruleReasons } from '../../server/autoChallenge';
import { gitEnv, initRepo, tempDir } from '../helpers/server';

const f = (p: string, added = 1, removed = 0) => ({ path: p, added, removed });

describe('ruleReasons', () => {
  const rules = defaultAutoChallenge();
  it('names the files and the rule that matched', () => {
    expect(ruleReasons([f('src/styles.css'), f('index.html')], rules)).toEqual(['Changed src/styles.css (rule **/*.css)']);
    expect(ruleReasons([f('server/auth/login.ts')], rules)[0]).toContain('**/auth/**');
    expect(ruleReasons([f('package.json')], rules).length).toBeGreaterThan(0);
  });
  it('counts lines added and removed against the size rule', () => {
    expect(ruleReasons([f('a.ts', 100, 60)], rules)).toEqual(['Changed 160 lines in total (rule: at least 150 lines)']);
    expect(ruleReasons([f('a.ts', 100, 40)], rules)).toEqual([]);
    expect(ruleReasons([f('a.ts', 900, 0)], { ...rules, minLines: 0 })).toEqual([]);
  });
  it('shortens a long list of files', () => {
    expect(ruleReasons([f('a.css'), f('b.css'), f('c.css'), f('d.css')], { ...rules, minLines: 0 })[0]).toContain('and others (4 files)');
  });
});

describe('parseNumstat', () => {
  it('reads lines and treats binary files as one line', () => {
    expect(parseNumstat('3\t1\tsrc/a.ts\n-\t-\tlogo.png\n')).toEqual([f('src/a.ts', 3, 1), f('logo.png', 1, 1)]);
  });
});

describe('autoChallengeReasons', () => {
  it('reviews a matching change once per state, at most twice per request, and again after the user speaks', async () => {
    const dir = tempDir('crew-auto');
    const env = gitEnv(dir);
    const repo = path.join(dir, 'repo');
    initRepo(repo, env, { 'index.html': '<h1>hi</h1>\n', 'styles.css': 'h1 {}\n' });
    Object.assign(process.env, env);
    const project = { id: 'p', path: repo } as any;
    const chat = { id: 'c_auto' } as any;
    const rules = defaultAutoChallenge();

    expect(await autoChallengeReasons(chat, project, rules)).toBeNull(); // nothing changed
    fs.writeFileSync(path.join(repo, 'index.html'), '<h1>hello</h1>\n');
    expect(await autoChallengeReasons(chat, project, rules)).toBeNull(); // changed, but no rule matches
    fs.appendFileSync(path.join(repo, 'styles.css'), 'p {}\n');
    expect(await autoChallengeReasons(chat, project, rules)).toEqual(['Changed styles.css (rule **/*.css)']);
    expect(await autoChallengeReasons(chat, project, rules)).toBeNull(); // the same state again
    fs.appendFileSync(path.join(repo, 'styles.css'), 'a {}\n');
    expect(await autoChallengeReasons(chat, project, rules)).not.toBeNull(); // a fix: second look
    fs.appendFileSync(path.join(repo, 'styles.css'), 'b {}\n');
    expect(await autoChallengeReasons(chat, project, rules)).toBeNull(); // two per request
    resetAutoChallenge(chat.id);
    expect(await autoChallengeReasons(chat, project, rules)).not.toBeNull();
    expect(await autoChallengeReasons(chat, project, { ...rules, enabled: false })).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
