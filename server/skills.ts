import fs from 'node:fs';
import path from 'node:path';
import type { RecordedStep, Skill } from '../shared/types';
import { bus } from './bus';
import { DATA } from './config';
import { BUILTIN_SKILLS } from './data/builtinSkills';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function parse(file: string): Skill | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    const meta: Record<string, string> = {};
    let body = raw;
    if (m) {
      for (const line of m[1].split('\n')) {
        const i = line.indexOf(':');
        if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      body = m[2];
    }
    const name = meta.name || path.basename(file, '.md');
    return {
      name,
      title: meta.title || name,
      description: meta.description || '',
      icon: meta.icon || '⚡',
      argsHint: meta.argsHint || '',
      body: body.trim(),
      builtin: false,
      updatedAt: fs.statSync(file).mtimeMs,
    };
  } catch {
    return null;
  }
}

function serialize(s: Skill): string {
  const oneLine = (v: string) => v.replace(/\n/g, ' ');
  return [
    '---',
    `name: ${s.name}`,
    `title: ${oneLine(s.title)}`,
    `icon: ${oneLine(s.icon)}`,
    `argsHint: ${oneLine(s.argsHint || '')}`,
    `description: ${oneLine(s.description)}`,
    '---',
    s.body.trim(),
    '',
  ].join('\n');
}

export const skills = {
  list(): Skill[] {
    const map = new Map<string, Skill>();
    for (const b of BUILTIN_SKILLS) map.set(b.name, { ...b, builtin: true, updatedAt: 0 });
    for (const f of fs.readdirSync(DATA.skills)) {
      if (!f.endsWith('.md')) continue;
      const s = parse(path.join(DATA.skills, f));
      // A user file with a built-in's name overrides it.
      if (s) map.set(s.name, { ...s, builtin: false });
    }
    return [...map.values()];
  },

  get(name: string): Skill | undefined {
    return this.list().find((s) => s.name === name);
  },

  save(input: Partial<Skill> & { name: string }, previousName?: string): Skill {
    const name = input.name.trim().toLowerCase();
    if (!NAME_RE.test(name)) throw new Error('技能名只能包含小写字母、数字和连字符（最多 40 个字符）');
    const s: Skill = {
      name,
      title: input.title?.trim() || name,
      description: input.description?.trim() || '',
      icon: input.icon?.trim() || '⚡',
      argsHint: input.argsHint?.trim() || '',
      body: input.body?.trim() || '',
      builtin: false,
      updatedAt: Date.now(),
    };
    if (!s.body) throw new Error('技能内容不能为空');
    // Renaming: drop the old file and tell clients (a renamed override brings its built-in back).
    if (previousName && previousName !== name) this.remove(previousName);
    fs.writeFileSync(path.join(DATA.skills, `${name}.md`), serialize(s));
    bus.emit({ t: 'skill', skill: s });
    return s;
  },

  /** Deletes a user skill; for an overridden built-in this restores the original. */
  remove(name: string, announce = true) {
    fs.rmSync(path.join(DATA.skills, `${name}.md`), { force: true });
    if (!announce) return;
    const builtin = BUILTIN_SKILLS.find((b) => b.name === name);
    if (builtin) bus.emit({ t: 'skill', skill: { ...builtin, builtin: true, updatedAt: 0 } });
    else bus.emit({ t: 'skill_deleted', name });
  },

  /** Expands a leading "/name args" into the skill's prompt. */
  expand(text: string): { text: string; skill?: Skill } {
    const m = text.match(/^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/);
    if (!m) return { text };
    const skill = this.get(m[1]);
    if (!skill) return { text };
    const args = (m[2] || '').trim();
    let body = skill.body;
    if (body.includes('{{args}}')) body = body.split('{{args}}').join(args);
    else if (args) body += `\n\n补充说明：${args}`;
    return { text: body, skill };
  },
};

/** Turns a recorded browser demo into a reusable skill body. */
export function recordingToSkillBody(steps: RecordedStep[], startPage: string, goal: string): string {
  const lines = steps.map((s, i) => {
    const n = `${i + 1}.`;
    switch (s.type) {
      case 'click':
        return `${n} 点击 ${s.text ? `「${s.text}」` : ''}（${s.selector}）`;
      case 'fill':
        return `${n} 在 ${s.text ? `「${s.text}」` : ''}输入框（${s.selector}）中填写 ${s.value === '******' ? '（密码，向用户询问或使用测试账号）' : `「${s.value}」`}`;
      case 'select':
        return `${n} 在下拉框（${s.selector}）中选择「${s.value}」`;
      case 'check':
        return `${n} ${s.value === 'true' ? '勾选' : '取消勾选'} ${s.text ? `「${s.text}」` : ''}（${s.selector}）`;
      case 'press':
        return `${n} 按下 ${s.key}${s.selector ? `（焦点在 ${s.selector}）` : ''}`;
      case 'submit':
        return `${n} 提交表单（${s.selector}）`;
      case 'navigate':
        return `${n} 页面跳转到 ${s.url}`;
      default:
        return `${n} ${JSON.stringify(s)}`;
    }
  });
  return [
    `目标：${goal || '重复我演示的这个操作流程，并确认每一步都成功。'}`,
    '',
    `这是我在页面 ${startPage} 上录制的操作演示：`,
    ...lines,
    '',
    '请用 browser_act 按顺序复现这些步骤（先打开起始页面；选择器失效时按文字或语义重新定位元素），',
    '每个关键步骤后检查页面状态和控制台报错，最后用 preview_screenshot 截图并汇报结果。{{args}}',
  ].join('\n');
}
