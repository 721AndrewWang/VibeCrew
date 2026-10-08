// Friction: the moments Crew got in the way. A chain that stopped with no handoff, the hop limit,
// approvals the user denied or waited long for, approvals for read-only commands (a rule that is
// too broad), notes about files that changed outside the chat, turns that errored. Each is one line
// in an append-only log; the report groups them so the worst problems, with the chats they came
// from, can be handed to a team that fixes Crew. Nothing here changes how Crew behaves.

import fs from 'node:fs';
import type { FrictionEvent, FrictionKind, FrictionReport } from '../shared/types';
import { DATA } from './config';
import { logger } from './log';

const log = logger('friction');

export const FRICTION_LABEL: Record<FrictionKind, string> = {
  stall: '接力停住，靠卡住检测叫醒负责人',
  'hop-limit': '自动接力达到上限',
  'approval-denied': '你拒绝的审批',
  'approval-readonly': '只读命令也来问你（规则可能太宽）',
  'approval-slow': '审批等了 10 分钟以上',
  'outside-edit': '「聊天之外改了文件」通知',
  'turn-error': '机器人这一轮出错',
};

/** Approvals answered later than this count as slow. */
export const SLOW_APPROVAL_MS = 10 * 60_000;

export function recordFriction(e: Omit<FrictionEvent, 'at'> & { at?: number }) {
  const event: FrictionEvent = { ...e, at: e.at ?? Date.now(), detail: e.detail.replace(/\s+/g, ' ').slice(0, 300) };
  try {
    fs.appendFileSync(DATA.friction, `${JSON.stringify(event)}\n`);
  } catch (err) {
    log.warn('could not record:', (err as Error).message);
  }
}

export function readFriction(since: number): FrictionEvent[] {
  let text = '';
  try {
    text = fs.readFileSync(DATA.friction, 'utf8');
  } catch {
    return [];
  }
  const out: FrictionEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as FrictionEvent;
      if (e.at >= since && e.kind in FRICTION_LABEL) out.push(e);
    } catch {
      /* a torn last line */
    }
  }
  return out;
}

/** Events grouped by kind, then by what lies behind them (the rule, the path, the bot), worst first. */
export function frictionReport(days: number, now = Date.now()): FrictionReport {
  const since = now - days * 86_400_000;
  const events = readFriction(since);
  const kinds = (Object.keys(FRICTION_LABEL) as FrictionKind[])
    .map((kind) => {
      const of = events.filter((e) => e.kind === kind);
      const byKey = new Map<string, FrictionEvent[]>();
      for (const e of of) byKey.set(e.key, [...(byKey.get(e.key) || []), e]);
      const groups = [...byKey.entries()]
        .map(([key, list]) => ({ key, count: list.length, examples: list.slice(-3).reverse() }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
      return { kind, label: FRICTION_LABEL[kind], count: of.length, groups };
    })
    .filter((k) => k.count > 0)
    .sort((a, b) => b.count - a.count);
  return { days, since, total: events.length, kinds, brief: frictionBrief(days, kinds) };
}

/** Files a fix may only touch after asking: the code that decides what bots are allowed to do. */
export const GUARDED_FILES = ['server/agents/permissions.ts', 'server/orchestrator/permissionGate.ts', 'server/sandbox.ts', 'server/security.ts', 'server/data/catalog.ts'];

/**
 * The message that hands the report to a group working on Crew's own code. `{lead}` is replaced
 * with the group's lead by the app. The user stays the one who merges, packages and restarts.
 */
export function frictionBrief(days: number, kinds: FrictionReport['kinds']): string {
  if (!kinds.length) return '';
  const lines = kinds.flatMap((k) => [
    `- ${k.label}：${k.count} 次`,
    ...k.groups.slice(0, 3).map((g) => `  - ${g.key}（${g.count} 次）例：${g.examples[0].detail}${g.examples[0].chatTitle ? `（「${g.examples[0].chatTitle}」）` : ''}`),
  ]);
  return [
    `@{lead} 这是 Crew 最近 ${days} 天的摩擦报告，按次数从多到少：`,
    '',
    ...lines,
    '',
    '请挑一条影响最大、一个分支里修得完的问题来修：',
    '1. 先复述问题和证据（需要时用 chat_history 读原对话），说清楚根因，再动手。修不了或不该修（比如是用户自己的选择），就说明理由，换下一条。',
    '2. 在这个对话的独立工作区（分支）里改，补上能复现问题的测试，跑 npm run check 全部通过。',
    '3. 交给 Lens 审查、Skeptic 证伪，推翻的都修掉。',
    `4. 改到 ${GUARDED_FILES.join('、')} 之前先停下来问用户：这些文件决定机器人能做什么。`,
    '5. 不要合并、推送、打包、重启 Crew，也不要改 ~/.crew 里的数据；最后把分支名、改动、测试结果和还不确定的地方汇总给用户，由用户决定。',
  ].join('\n');
}
