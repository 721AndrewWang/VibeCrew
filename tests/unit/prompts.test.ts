import { describe, expect, it } from 'vitest';
import { buildTurnPrompt, contextDelta } from '../../server/agents/prompts';

describe('contextDelta', () => {
  const first = ['Time: 10:00', 'Preview: static page', 'Forbidden actions: Bash(*x*)', 'Sandbox: local machine only'];
  it('sends everything the first time', () => {
    expect(contextDelta(undefined, first)).toEqual(first);
  });
  it('then only the time and what changed, saying the rest is unchanged', () => {
    expect(contextDelta(first, ['Time: 10:05', ...first.slice(1)])).toEqual(['Time: 10:05', '(The rest of the environment is unchanged.)']);
    expect(contextDelta(first, ['Time: 10:05', 'Preview: dev server running', ...first.slice(2)])).toEqual([
      'Time: 10:05',
      'Preview: dev server running',
      '(The rest of the environment is unchanged.)',
    ]);
  });
  it('says what no longer applies', () => {
    expect(contextDelta(first, ['Time: 10:05', 'Preview: static page', 'Sandbox: local machine only'])).toEqual([
      'Time: 10:05',
      'No longer applies: Forbidden actions: Bash(*x*)',
      '(The rest of the environment is unchanged.)',
    ]);
  });
});

describe('buildTurnPrompt in a group', () => {
  const names = new Map([
    ['b_chief', 'Chief'],
    ['b_lens', 'Lens'],
    ['b_probe', 'Probe'],
  ]);
  const long = (head: string) => `${head}\n${'Details. '.repeat(120).trim()}`;
  const msg = (seq: number, role: 'user' | 'bot', text: string, botId?: string) => ({ id: `m${seq}`, seq, role, text, botId, chatId: 'c', ts: seq }) as any;
  const unseen = [
    msg(5, 'bot', long('Review done, no blocking issues.'), 'b_lens'),
    msg(6, 'bot', long('Section added, Probe signed off.'), 'b_chief'),
    msg(7, 'user', 'Use hello@mysite.test as the email, then have Probe check it.'),
    msg(8, 'bot', long('All three are fixed. @Probe please check this change.'), 'b_chief'),
  ];
  const prompt = buildTurnPrompt({ bot: { name: 'Probe' } as any, chat: { kind: 'group', title: 'Web team' } as any, unseen, names, context: [], trigger: { type: 'mention', by: 'b_chief' } });

  it('keeps the user and the handoff in full', () => {
    expect(prompt).toContain('Use hello@mysite.test as the email, then have Probe check it.');
    expect(prompt).toContain(unseen[3].text);
  });
  it('turns older long teammate messages into one line with their number', () => {
    expect(prompt).toContain('[@Lens · #5] Review done, no blocking issues. (full text');
    expect(prompt).toContain('[@Chief · #6] Section added, Probe signed off. (full text');
    expect(prompt).not.toContain(unseen[0].text);
    expect(prompt).toContain('chat_history');
    expect(prompt.length).toBeLessThan(unseen.reduce((n: number, m: any) => n + m.text.length, 0) * 0.6);
  });
  it('leaves short messages alone', () => {
    const p = buildTurnPrompt({
      bot: { name: 'Probe' } as any,
      chat: { kind: 'group', title: 'g' } as any,
      unseen: [msg(1, 'bot', 'OK, let me take a look.', 'b_lens'), msg(2, 'bot', '@Probe your turn.', 'b_chief')],
      names,
      context: [],
      trigger: { type: 'mention', by: 'b_chief' },
    });
    expect(p).toContain('[@Lens]\nOK, let me take a look.');
  });
});

describe('the recap after a session starts over', () => {
  const names = new Map([
    ['b_pixel', 'Pixel'],
    ['b_chief', 'Chief'],
  ]);
  const long = (head: string) => `${head}\n${'Details. '.repeat(120).trim()}`;
  const msg = (seq: number, role: 'user' | 'bot', text: string, botId?: string) => ({ id: `m${seq}`, seq, role, text, botId, chatId: 'c', ts: seq }) as any;
  const prompt = buildTurnPrompt({
    bot: { id: 'b_pixel', name: 'Pixel' } as any,
    chat: { kind: 'group', title: 'g' } as any,
    unseen: [msg(3, 'user', 'make a contact section'), msg(4, 'bot', long('Updated index.html and styles.css.'), 'b_pixel'), msg(5, 'bot', '@Pixel make the button a bit darker', 'b_chief')],
    names,
    context: [],
    trigger: { type: 'mention', by: 'b_chief' },
    recap: { tokens: 62_524 },
  });
  it('says why and how big the old session was, and where the rest is', () => {
    expect(prompt).toContain('This is a new session');
    expect(prompt).toContain('63k tokens');
    expect(prompt).toContain('chat_history');
  });
  it("brings back the bot's own replies, labelled as its own, long ones as a line", () => {
    expect(prompt).toContain('[You (@Pixel) · #4] Updated index.html and styles.css. (full text');
    expect(prompt).not.toContain('Details. Details.');
  });
  it('keeps the user and the latest message in full', () => {
    expect(prompt).toContain('[User · #3]\nmake a contact section');
    expect(prompt).toContain('[@Chief · #5]\n@Pixel make the button a bit darker');
  });
});
