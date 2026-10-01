import { describe, expect, it } from 'vitest';
import { decide, harmless, matchingRule, permissionModeFor, rulesAllow, rulesTouch, splitCommand, suggestRules } from '../../server/agents/permissions';

const cwd = '/home/u/BioBuddy';
const bot = (over: Record<string, unknown> = {}) => ({ askRules: ['Bash(git push:*)'], allowRules: [], ...over }) as any;
const bash = (command: string) => ({ command });

describe('splitCommand', () => {
  it('splits on ; && || | and newlines, not inside quotes', () => {
    expect(splitCommand(`cd a && git log | head; echo 'x;y' || true`).map((s) => s.trim())).toEqual(['cd a', 'git log', 'head', "echo 'x;y'", 'true']);
  });
});

describe('harmless', () => {
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
  const cmd = `cd /home/u/BioBuddy; git fetch -q origin 2>&1 | tail -2; git log --oneline main..origin/main | head; find / -path /proc -prune -o -name summary.jsonl -print 2>/dev/null | head; grep -n -E 'matched' docs/x.md | head -20`;

  it('gives one rule per real command and none for helpers', () => {
    expect(suggestRules('Bash', bash(cmd), cwd)).toEqual(['Bash(git fetch*)', 'Bash(git log*)', 'Bash(find*)', 'Bash(grep*)']);
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

describe('matchingRule', () => {
  it('names the first rule that touches any part of the command', () => {
    expect(matchingRule(['Bash(*zero1*)', 'Bash(*zero3*)'], 'Bash', bash('cd x && ssh zero3 ls'), cwd)).toBe('Bash(*zero3*)');
    expect(matchingRule(['Bash(*zero3*)'], 'Bash', bash('ls'), cwd)).toBeNull();
  });
});

describe('deny-list matching (rulesTouch)', () => {
  const rules = ['Bash(*zero1*)', 'Bash(*10.0.0.5*)'];
  it('catches the host or the address in any part of a compound command', () => {
    expect(rulesTouch(rules, 'Bash', bash('cd x && ssh zero1 uptime'), cwd)).toBe(true);
    expect(rulesTouch(rules, 'Bash', bash('rsync -a out/ admin@10.0.0.5:/srv/'), cwd)).toBe(true);
  });
  it('leaves other commands alone', () => {
    expect(rulesTouch(rules, 'Bash', bash('ssh zero3 uptime'), cwd)).toBe(false);
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
