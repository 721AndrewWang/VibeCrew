import { describe, expect, it } from 'vitest';
import { buildSystemAppend } from '../../server/agents/prompts';
import { CONTINUE_MARK, continueNote, leadContinues, MAX_STALL_NUDGES, stalledLead, stallNote } from '../../server/stall';

const chief = { id: 'b_chief', name: 'Chief' } as any;
const lens = { id: 'b_lens', name: 'Lens' } as any;
const members = [chief, lens];
const chat = { kind: 'group', leadBotId: 'b_chief' } as any;
let seq = 0;
const m = (role: string, text = '', extra: object = {}) => ({ id: `m${++seq}`, seq, role, text, status: 'done', ...extra }) as any;

function ask(opts: { history: any[]; msg?: any; bot?: any; mentioned?: any[]; trigger?: any; chat?: any }) {
  const msg = opts.msg ?? m('bot', 'Review done, nothing that must be fixed.', { botId: (opts.bot ?? lens).id });
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
    expect(ask({ history: [m('user', 'Do batch 1'), m('bot', '@Lens please review', { botId: 'b_chief' })] })).toBe(chief);
  });

  it('stays quiet when the teammate handed on, or is the lead, or the turn did not finish', () => {
    const history = [m('user', 'Do batch 1')];
    expect(ask({ history, mentioned: [chief] })).toBeNull();
    expect(ask({ history, bot: chief, msg: m('bot', 'Here is the summary', { botId: 'b_chief' }) })).toBeNull();
    expect(ask({ history, msg: m('bot', '', { botId: 'b_lens', status: 'error' }) })).toBeNull();
  });

  it('lets an automatic review that refuted nothing end the chain, and wakes the lead for one that refuted something', () => {
    const history = [m('user', 'Make a page')];
    const review = (refuted: number) => m('bot', `Verdict: ${refuted ? `refuted ${refuted}` : 'not refuted'}`, { botId: 'b_lens', meta: { verdict: { refuted } } });
    expect(ask({ history, trigger: { type: 'system' }, msg: review(0) })).toBeNull();
    expect(ask({ history, trigger: { type: 'system' }, msg: review(2) })).toBe(chief);
  });

  it('needs a group with a lead', () => {
    const history = [m('user', 'Take a look')];
    expect(ask({ history, chat: { kind: 'dm' } })).toBeNull();
    expect(ask({ history, chat: { kind: 'group' } })).toBeNull();
  });

  it('lets a teammate the user addressed answer the user, unless the user asked the lead to follow up', () => {
    expect(ask({ history: [m('user', '@Lens look at this')], trigger: { type: 'user' } })).toBeNull();
    expect(ask({ history: [m('user', '@Lens look at this, then report to @Chief to double-check')], trigger: { type: 'user' } })).toBe(chief);
  });

  it('gives up after a few nudges per user request, and starts over with the next one', () => {
    const asked = m('user', 'Do batch 1');
    const nudges = Array.from({ length: MAX_STALL_NUDGES }, () => m('system', stallNote('Lens', 'Chief'), { notice: 'stall' }));
    expect(ask({ history: [asked, ...nudges] })).toBeNull();
    expect(ask({ history: [asked, ...nudges, m('user', 'Go on')] })).toBe(chief);
  });
});

describe('leadContinues', () => {
  const lead = (text: string, extra: object = {}) => m('bot', text, { botId: 'b_chief', ...extra });
  const go = (msg: any, history: any[], opts: { bot?: any; mentioned?: any[]; chat?: any } = {}) =>
    leadContinues({ chat: opts.chat ?? chat, bot: opts.bot ?? chief, msg, mentioned: opts.mentioned ?? [], history: [...history, msg] });

  it('gives the lead another turn when it ends with the continue line on its own', () => {
    expect(go(lead(`Committed. Sending Lens next.\n${CONTINUE_MARK}`), [m('user', 'Wrap it up')])).toBe(true);
    expect(go(lead(`Committed.\n  ${CONTINUE_MARK}  `), [m('user', 'Wrap it up')])).toBe(true);
  });

  it('not for the mark inside a sentence, a teammate, a handoff, or a group without that lead', () => {
    const history = [m('user', 'Wrap it up')];
    expect(go(lead(`Writing ${CONTINUE_MARK} keeps it going`), history)).toBe(false);
    expect(go(m('bot', CONTINUE_MARK, { botId: 'b_lens' }), history, { bot: lens })).toBe(false);
    expect(go(lead(`@Lens please review\n${CONTINUE_MARK}`), history, { mentioned: [lens] })).toBe(false);
    expect(go(lead(CONTINUE_MARK), history, { chat: { kind: 'group', leadBotId: 'b_lens' } })).toBe(false);
  });

  it('shares the per-request budget with stall nudges', () => {
    const asked = m('user', 'Wrap it up');
    const used = Array.from({ length: MAX_STALL_NUDGES }, () => m('system', continueNote('Chief'), { notice: 'stall' }));
    expect(go(lead(CONTINUE_MARK), [asked, ...used])).toBe(false);
  });
});

describe('the lead is told about the continue line', () => {
  const team = [
    { id: 'b_chief', name: 'Chief', title: 'Lead', description: 'x', permission: 'edits' },
    { id: 'b_lens', name: 'Lens', title: 'Review', description: 'x', permission: 'plan' },
  ] as any[];
  const group = { kind: 'group', title: 'g', botIds: ['b_chief', 'b_lens'], leadBotId: 'b_chief' } as any;
  it('only in its own system prompt', () => {
    expect(buildSystemAppend({ bot: team[0], chat: group, project: null, team, skills: [] })).toContain(CONTINUE_MARK);
    expect(buildSystemAppend({ bot: team[1], chat: group, project: null, team, skills: [] })).not.toContain(CONTINUE_MARK);
  });
});
