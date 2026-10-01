import { describe, expect, it } from 'vitest';
import { buildTurnPrompt, contextDelta } from '../../server/agents/prompts';

describe('contextDelta', () => {
  const first = ['时间：10:00', '预览：静态网页', '禁止的操作：Bash(*x*)', '沙盒：只能访问本机'];
  it('sends everything the first time', () => {
    expect(contextDelta(undefined, first)).toEqual(first);
  });
  it('then only the time and what changed, saying the rest is unchanged', () => {
    expect(contextDelta(first, ['时间：10:05', ...first.slice(1)])).toEqual(['时间：10:05', '（其余环境信息和之前一样）']);
    expect(contextDelta(first, ['时间：10:05', '预览：开发服务器运行中', ...first.slice(2)])).toEqual(['时间：10:05', '预览：开发服务器运行中', '（其余环境信息和之前一样）']);
  });
  it('says what no longer applies', () => {
    expect(contextDelta(first, ['时间：10:05', '预览：静态网页', '沙盒：只能访问本机'])).toEqual(['时间：10:05', '不再适用：禁止的操作：Bash(*x*)', '（其余环境信息和之前一样）']);
  });
});

describe('buildTurnPrompt in a group', () => {
  const names = new Map([
    ['b_chief', 'Chief'],
    ['b_lens', 'Lens'],
    ['b_probe', 'Probe'],
  ]);
  const long = (head: string) => `${head}\n${'细节。'.repeat(120)}`;
  const msg = (seq: number, role: 'user' | 'bot', text: string, botId?: string) => ({ id: `m${seq}`, seq, role, text, botId, chatId: 'c', ts: seq }) as any;
  const unseen = [
    msg(5, 'bot', long('审查完成，没有阻塞性问题。'), 'b_lens'),
    msg(6, 'bot', long('区块加好了，Probe 验收通过。'), 'b_chief'),
    msg(7, 'user', '邮箱用 hello@mysite.test，改完让 Probe 验收。'),
    msg(8, 'bot', long('三处都改好了。@Probe 请验收这次改动。'), 'b_chief'),
  ];
  const prompt = buildTurnPrompt({ bot: { name: 'Probe' } as any, chat: { kind: 'group', title: 'Web 小队' } as any, unseen, names, context: [], trigger: { type: 'mention', by: 'b_chief' } });

  it('keeps the user and the handoff in full', () => {
    expect(prompt).toContain('邮箱用 hello@mysite.test，改完让 Probe 验收。');
    expect(prompt).toContain(unseen[3].text);
  });
  it('turns older long teammate messages into one line with their number', () => {
    expect(prompt).toContain('【@Lens · #5】审查完成，没有阻塞性问题。（全文');
    expect(prompt).toContain('【@Chief · #6】区块加好了，Probe 验收通过。（全文');
    expect(prompt).not.toContain(unseen[0].text);
    expect(prompt).toContain('chat_history');
    expect(prompt.length).toBeLessThan(unseen.reduce((n: number, m: any) => n + m.text.length, 0) * 0.6);
  });
  it('leaves short messages alone', () => {
    const p = buildTurnPrompt({
      bot: { name: 'Probe' } as any,
      chat: { kind: 'group', title: 'g' } as any,
      unseen: [msg(1, 'bot', '好的，我看一下。', 'b_lens'), msg(2, 'bot', '@Probe 你来。', 'b_chief')],
      names,
      context: [],
      trigger: { type: 'mention', by: 'b_chief' },
    });
    expect(p).toContain('【@Lens】\n好的，我看一下。');
  });
});
