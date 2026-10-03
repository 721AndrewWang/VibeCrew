import { describe, expect, it } from 'vitest';
import { MAX_STALL_NUDGES, stalledLead, stallNote } from '../../server/stall';

const chief = { id: 'b_chief', name: 'Chief' } as any;
const lens = { id: 'b_lens', name: 'Lens' } as any;
const members = [chief, lens];
const chat = { kind: 'group', leadBotId: 'b_chief' } as any;
let seq = 0;
const m = (role: string, text = '', extra: object = {}) => ({ id: `m${++seq}`, seq, role, text, status: 'done', ...extra }) as any;

function ask(opts: { history: any[]; msg?: any; bot?: any; mentioned?: any[]; trigger?: any; chat?: any }) {
  const msg = opts.msg ?? m('bot', '审完了，没有必须修的问题。', { botId: (opts.bot ?? lens).id });
  return stalledLead({
    chat: opts.chat ?? chat,
    bot: opts.bot ?? lens,
    msg,
    mentioned: opts.mentioned ?? [],
    history: [...opts.history, msg],
    trigger: opts.trigger ?? { type: 'mention', by: 'b_chief' },
    members,
  });
}

describe('stalledLead', () => {
  it('wakes the lead when a teammate it handed work to reports back to no one', () => {
    expect(ask({ history: [m('user', '做第 1 批'), m('bot', '@Lens 审一下', { botId: 'b_chief' })] })).toBe(chief);
  });

  it('stays quiet when the teammate handed on, or is the lead, or the turn did not finish', () => {
    const history = [m('user', '做第 1 批')];
    expect(ask({ history, mentioned: [chief] })).toBeNull();
    expect(ask({ history, bot: chief, msg: m('bot', '汇总如下', { botId: 'b_chief' }) })).toBeNull();
    expect(ask({ history, msg: m('bot', '', { botId: 'b_lens', status: 'error' }) })).toBeNull();
  });

  it('lets an automatic review that refuted nothing end the chain, and wakes the lead for one that refuted something', () => {
    const history = [m('user', '做一个页面')];
    const review = (refuted: number) => m('bot', `结论：${refuted ? `推翻 ${refuted} 条` : '未推翻'}`, { botId: 'b_lens', meta: { verdict: { refuted } } });
    expect(ask({ history, trigger: { type: 'system' }, msg: review(0) })).toBeNull();
    expect(ask({ history, trigger: { type: 'system' }, msg: review(2) })).toBe(chief);
  });

  it('needs a group with a lead', () => {
    const history = [m('user', '看看')];
    expect(ask({ history, chat: { kind: 'dm' } })).toBeNull();
    expect(ask({ history, chat: { kind: 'group' } })).toBeNull();
  });

  it('lets a teammate the user addressed answer the user, unless the user asked the lead to follow up', () => {
    expect(ask({ history: [m('user', '@Lens 看看这个')], trigger: { type: 'user' } })).toBeNull();
    expect(ask({ history: [m('user', '@Lens 看看这个，报完 @Chief 核对')], trigger: { type: 'user' } })).toBe(chief);
  });

  it('gives up after a few nudges per user request, and starts over with the next one', () => {
    const asked = m('user', '做第 1 批');
    const nudges = Array.from({ length: MAX_STALL_NUDGES }, () => m('system', stallNote('Lens', 'Chief'), { notice: 'stall' }));
    expect(ask({ history: [asked, ...nudges] })).toBeNull();
    expect(ask({ history: [asked, ...nudges, m('user', '继续')] })).toBe(chief);
  });
});
