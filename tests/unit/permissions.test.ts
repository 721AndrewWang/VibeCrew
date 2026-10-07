import { describe, expect, it } from 'vitest';
import { askRuleFor, decide, harmless, matchingRule, permissionModeFor, rulesAllow, rulesTouch, ruleText, splitCommand, suggestRules } from '../../server/agents/permissions';
import { DEFAULT_ASK_RULES } from '../../server/data/catalog';

const cwd = '/home/u/site';
const bot = (over: Record<string, unknown> = {}) => ({ askRules: ['Bash(git push:*)'], allowRules: [], ...over }) as any;
const bash = (command: string) => ({ command });

describe('splitCommand', () => {
  it('splits on ; && || | and newlines, not inside quotes', () => {
    expect(splitCommand(`cd a && git log | head; echo 'x;y' || true`).map((s) => s.trim())).toEqual(['cd a', 'git log', 'head', "echo 'x;y'", 'true']);
  });
});

describe('harmless', () => {
  it('includes searching and listing, which cannot write', () => {
    expect(['grep -n x a.css', 'ls -la', 'ls | grep x'].every((c) => splitCommand(c).every(harmless))).toBe(true);
    expect(harmless('grep x a > out.txt')).toBe(false);
  });
  it('accepts commands that only read or print', () => {
    for (const c of ['cd /tmp', 'head -20', 'tail -2', "echo 'done'", 'cat README.md', 'wc -l x', 'pwd']) expect(harmless(c), c).toBe(true);
  });
  it('allows 2>&1 and /dev/null', () => {
    expect(harmless('cat x 2>&1')).toBe(true);
    expect(harmless('head x 2>/dev/null')).toBe(true);
  });
  it('rejects writing files and command substitution', () => {
    for (const c of ['echo hi > notes.txt', 'cat a >> b', 'echo $(rm -rf /)', 'echo `id`', 'sort -o x y', 'rm -rf build']) expect(harmless(c), c).toBe(false);
  });
});

describe('suggestRules', () => {
  // The compound command from a real approval card.
  const cmd = `cd /home/u/site; git fetch -q origin 2>&1 | tail -2; git log --oneline main..origin/main | head; find / -path /proc -prune -o -name summary.jsonl -print 2>/dev/null | head; grep -n -E 'matched' docs/x.md | head -20`;

  it('gives one rule per real command and none for helpers', () => {
    expect(suggestRules('Bash', bash(cmd), cwd)).toEqual(['Bash(git fetch*)', 'Bash(git log*)', 'Bash(find*)']);
  });
  it('covers the whole command next time', () => {
    expect(rulesAllow(suggestRules('Bash', bash(cmd), cwd), 'Bash', bash(cmd), cwd)).toBe(true);
  });
  it('a rule for the first command alone never covered it', () => {
    expect(rulesAllow(['Bash(cd*)'], 'Bash', bash(cmd), cwd)).toBe(false);
  });
  it('still asks for a different real command', () => {
    expect(rulesAllow(suggestRules('Bash', bash(cmd), cwd), 'Bash', bash('cd x; rm -rf build'), cwd)).toBe(false);
  });
  it('skips leading VAR=value assignments', () => {
    expect(suggestRules('Bash', bash('NODE_ENV=test npm run build'), cwd)).toEqual(['Bash(npm run build*)']);
  });
  it('keeps one rule for other tools', () => {
    expect(suggestRules('WebFetch', { url: 'https://docs.example.com/x' }, cwd)).toEqual(['WebFetch(domain:docs.example.com)']);
  });
});

describe('decide', () => {
  it('runs read-only compounds without asking in 自动改文件', () => {
    expect(decide(bot(), 'edits', 'Bash', bash('cd src && cat a.ts | head -40'), cwd, {}).behavior).toBe('allow');
  });
  it('asks for real commands in 自动改文件', () => {
    expect(decide(bot(), 'edits', 'Bash', bash('cd src && npm test'), cwd, {}).behavior).toBe('ask');
  });
  it('asks for everything in 每步确认', () => {
    expect(decide(bot(), 'ask', 'Bash', bash('cat a.ts'), cwd, {}).behavior).toBe('ask');
  });
  it('must-ask rules win over helpers and over 全自动', () => {
    expect(decide(bot(), 'edits', 'Bash', bash('cat a; git push'), cwd, {}).behavior).toBe('ask');
    expect(decide(bot(), 'auto', 'Bash', bash('git push origin main'), cwd, {}).behavior).toBe('ask');
  });
  it('a rule with * anywhere matches inside the command', () => {
    const b = bot({ askRules: ['Bash(*prod-server*)'] });
    expect(decide(b, 'auto', 'Bash', bash("ssh -o BatchMode=yes prod-server 'docker ps'"), cwd, {}).behavior).toBe('ask');
    expect(decide(b, 'auto', 'Bash', bash('cd /tmp && scp report.md prod-server:/tmp/'), cwd, {}).behavior).toBe('ask');
    expect(decide(b, 'auto', 'Bash', bash("ssh test-server 'uptime'"), cwd, {}).behavior).toBe('allow');
  });
  describe('a command that only reads is held only to the rules about files', () => {
    // The bots' default rules and the apellespell project's rules, as they were on 2026-10-07.
    const defaults = ['Bash(git push*)', 'Bash(sudo *)', 'Bash(rm -rf *)', 'Bash(npm publish*)', 'Bash(*deploy*)'];
    const project = [
      'Bash(bash server/deploy.sh:*)',
      'Bash(ssh:*)',
      'Bash(./server/deploy.sh:*)',
      'Bash(sh server/deploy.sh:*)',
      'Read(**/.env)',
      'Read(**/.env.local)',
      'Edit(**/.env)',
      'Edit(**/.env.local)',
      'Bash(*.env)',
      'Bash(*.env *)',
      'Bash(*.env.local*)',
    ];
    const b = bot({ askRules: defaults });
    const run = (cmd: string, matchedAskRule?: unknown) => decide(b, 'auto', 'Bash', bash(cmd), cwd, { projectRules: project, matchedAskRule });

    it('reading or searching deploy files no longer asks, even when Claude Code matched the rule', () => {
      for (const cmd of [
        'cd /home/u/site && grep -n "ports:" -A3 server/deploy/docker-compose.yml',
        'cat server/deploy.sh | head -40',
        'grep -n NODE_ENV Dockerfile.web server/deploy/docker-compose.yml; ls deploy',
        'grep -rn ssh docs/ | wc -l',
      ]) {
        // Claude Code reports the rule it matched on the raw text, if any.
        expect(run(cmd, cmd.includes('deploy') ? 'Bash(*deploy*)' : undefined).behavior, cmd).toBe('allow');
      }
    });

    it('running a deploy, ssh, a push or rm -rf still asks', () => {
      expect(run('bash server/deploy.sh').because).toContain('Bash(*deploy*)');
      expect(run('cd app && ./server/deploy.sh --prod').behavior).toBe('ask');
      expect(run('ssh andrew@host uptime').because).toContain('Bash(ssh:*)');
      expect(run('git status && git push origin main').behavior).toBe('ask');
      expect(run('rm -rf .tsxtmp && ls').behavior).toBe('ask');
      // Read-only tools, but written to a file: not harmless, so the plain rules apply.
      expect(run('grep deploy README.md > notes.txt').behavior).toBe('ask');
    });

    it('reading a protected file still asks, through the Read rules or the plain rules', () => {
      expect(run('cat app/apps/web/.env.local').because).toContain('Read(**/.env.local)');
      expect(run("grep AUTH 'app/apps/web/.env.local' | head").behavior).toBe('ask');
      expect(run('cd app && head -3 .env').because).toContain('Read(**/.env)');
      // A wildcard argument is not expanded: the plain rules decide, as before.
      expect(run('grep DATABASE_URL apps/web/.env.local*').behavior).toBe('ask');
      // Not protected: the example file.
      expect(run('cat app/.env.example').behavior).toBe('allow');
    });

    it('a rule about the reading command itself still applies', () => {
      const own = (rule: string, cmd: string) => decide(bot({ askRules: [rule] }), 'auto', 'Bash', bash(cmd), cwd, {}).behavior;
      expect(own('Bash(ls*)', 'ls -la')).toBe('ask');
      expect(own('Bash(cat *)', 'cd src && cat a.ts')).toBe('ask');
      expect(own('Bash(grep:*)', 'grep -rn TODO .')).toBe('ask');
      // …but not one whose word only shows up in an argument.
      expect(own('Bash(*ls*)', 'grep -n tools README.md')).toBe('allow');
    });

    it("Claude Code's own match of one of these rules defers to the check above, even with git log in the command", () => {
      // Approval #295 on 2026-10-07, which asked with "ask 规则 [object Object]".
      const cmd =
        'cd /home/ubuntu24/apellespell && grep -n "450fc09\\|orphan" docs/m4-deploy-checklist.md | cut -c1-200; grep -n "47\\|48" docs/m4-pr.md | cut -c1-160; git log --oneline main..HEAD | wc -l';
      expect(run(cmd, { toolName: 'Bash', ruleContent: '*deploy*' } as any).behavior).toBe('allow');
      // In 自动改文件 a command outside the read-only list still asks, for the mode's reason.
      expect(decide(b, 'edits', 'Bash', bash(cmd), cwd, { projectRules: project, matchedAskRule: { toolName: 'Bash', ruleContent: '*deploy*' } }).because).toBe('权限是「自动改文件」，运行命令要先问');
    });

    it('a rule Claude Code matched from somewhere else still asks, and is named readably', () => {
      const d = run('make release', { toolName: 'Bash', ruleContent: 'make release*' } as any);
      expect(d.behavior).toBe('ask');
      expect(d.because).toBe('Claude Code 设置里的 ask 规则 Bash(make release*)');
      expect(ruleText('Bash(x)')).toBe('Bash(x)');
      expect(ruleText({ toolName: 'WebFetch' })).toBe('WebFetch');
    });

    it('askRuleFor keeps matchingRule for other tools', () => {
      expect(askRuleFor(project, 'Read', { file_path: 'app/apps/web/.env.local' }, cwd)).toBe('Read(**/.env.local)');
      expect(askRuleFor(project, 'Read', { file_path: 'app/README.md' }, cwd)).toBeNull();
    });
  });

  it('a read-only bot cannot leave plan mode', () => {
    expect(decide(bot(), 'plan', 'ExitPlanMode', {}, cwd, {}).behavior).toBe('deny');
  });
  it('says what settled it, naming the rule and where it came from', () => {
    const why = (d: ReturnType<typeof decide>) => d.because;
    expect(why(decide(bot(), 'auto', 'Bash', bash('git push origin main'), cwd, {}))).toBe('机器人的「必须确认」规则 Bash(git push:*)');
    expect(why(decide(bot({ askRules: [] }), 'auto', 'Bash', bash('git push'), cwd, { projectRules: ['Bash(git push*)'] }))).toBe('项目的「必须确认」规则 Bash(git push*)');
    expect(why(decide(bot(), 'auto', 'Bash', bash('git push'), cwd, { matchedAskRule: 'Bash(git push:*)' }))).toContain('机器人的');
    expect(why(decide(bot(), 'ask', 'Bash', bash('npm test'), cwd, {}))).toBe('权限是「每步确认」');
    expect(why(decide(bot(), 'edits', 'Bash', bash('npm test'), cwd, {}))).toBe('权限是「自动改文件」，运行命令要先问');
    expect(why(decide(bot(), 'edits', 'Bash', bash('cat a | head'), cwd, {}))).toContain('只读取和打印');
    expect(why(decide(bot(), 'edits', 'Write', { file_path: '/etc/hosts' }, cwd, {}))).toContain('项目外');
    expect(why(decide(bot({ allowRules: ['Bash(npm test*)'] }), 'ask', 'Bash', bash('npm test'), cwd, {}))).toBe('「总是允许」规则 Bash(npm test*)');
    expect(why(decide(bot({ allowRules: ['Bash(npm test*)'] }), 'ask', 'Bash', bash('npm test && rm -rf dist'), cwd, {}))).toContain('只覆盖了命令的一部分');
    expect(why(decide(bot(), 'auto', 'Read', { file_path: 'a' }, cwd, {}))).toBe('只读操作');
  });
});

describe("a role's edit scope", () => {
  const probe = bot({ editScope: ['tests/**', '**/*.spec.*'] });
  it('refuses edits outside it, telling the bot to hand the file over', () => {
    const d = decide(probe, 'auto', 'Write', { file_path: 'src/app.ts' }, cwd, {});
    expect(d.behavior).toBe('deny');
    expect(d.because).toBe('角色范围只包括 tests/**、**/*.spec.*');
    if (d.behavior === 'deny') expect(d.message).toContain('@');
  });
  it('allows edits inside it, by relative or absolute path', () => {
    expect(decide(probe, 'auto', 'Edit', { file_path: 'tests/unit/a.test.ts' }, cwd, {}).behavior).toBe('allow');
    expect(decide(probe, 'auto', 'Write', { file_path: `${cwd}/web/app.spec.tsx` }, cwd, {}).behavior).toBe('allow');
  });
  it('does not limit reading or commands', () => {
    expect(decide(probe, 'auto', 'Read', { file_path: 'src/app.ts' }, cwd, {}).behavior).toBe('allow');
    expect(decide(probe, 'auto', 'Bash', bash('npm test'), cwd, {}).behavior).toBe('allow');
  });
  it('means nothing when empty', () => {
    expect(decide(bot({ editScope: [] }), 'auto', 'Write', { file_path: 'src/app.ts' }, cwd, {}).behavior).toBe('allow');
  });
});

describe('matchingRule', () => {
  it('names the first rule that touches any part of the command', () => {
    expect(matchingRule(['Bash(*host-a*)', 'Bash(*host-b*)'], 'Bash', bash('cd x && ssh host-b ls'), cwd)).toBe('Bash(*host-b*)');
    expect(matchingRule(['Bash(*host-b*)'], 'Bash', bash('ls'), cwd)).toBeNull();
  });
});

describe('deny-list matching (rulesTouch)', () => {
  const rules = ['Bash(*host-a*)', 'Bash(*10.0.0.5*)'];
  it('catches the host or the address in any part of a compound command', () => {
    expect(rulesTouch(rules, 'Bash', bash('cd x && ssh host-a uptime'), cwd)).toBe(true);
    expect(rulesTouch(rules, 'Bash', bash('rsync -a out/ admin@10.0.0.5:/srv/'), cwd)).toBe(true);
  });
  it('leaves other commands alone', () => {
    expect(rulesTouch(rules, 'Bash', bash('ssh host-b uptime'), cwd)).toBe(false);
  });
});

describe('permissionModeFor', () => {
  it('maps levels to Claude Code permission modes', () => {
    expect(permissionModeFor('edits')).toBe('acceptEdits');
    expect(permissionModeFor('review')).toBe('auto');
    expect(permissionModeFor('plan')).toBe('plan');
    expect(permissionModeFor('ask')).toBe('default');
  });
});

describe('the default must-ask rules', () => {
  const b = bot({ askRules: DEFAULT_ASK_RULES });
  const run = (cmd: string) => decide(b, 'auto', 'Bash', bash(cmd), cwd, {});
  it('ask before deploy commands, wherever they sit in a chain', () => {
    for (const cmd of [
      'npm run deploy',
      'cd web && pnpm deploy --prod',
      'vercel --prod',
      'npm test && fly deploy',
      'wrangler deploy',
      'firebase deploy --only hosting',
      'kubectl apply -f k8s/',
      'terraform apply -auto-approve',
      'git push origin main',
    ]) {
      expect(run(cmd).behavior, cmd).toBe('ask');
    }
  });
  it('do not ask because a command mentions deploying', () => {
    for (const cmd of [
      'grep -n ports: server/deploy/docker-compose.yml',
      `python3 -c "print('Deploy fix and PR docs')"`,
      'git commit -m "docs: deploy checklist"',
      'node scripts/check-deploy-docs.mjs',
    ]) {
      expect(run(cmd).behavior, cmd).toBe('allow');
    }
  });
});
