// Channel norms (ADR 103), the pure parts: the chat profile's checks, the gist of a Worker report,
// the asynchronous profiles for drafts, and what may leave through the webhook.
import { describe, expect, it } from 'vitest';
import { reportDetail } from '../../server/channels/details';
import { asyncProfileFor, asyncRefusal, chatRefusal, FOLD_LINES, isReplyKind, reportGist, shapeAsync, toolOutputIn, webhookText } from '../../server/channels/profiles';
import { notificationText, webhookPayload } from '../../server/channels/webhook';
import { maskUrl, normalizeWebhook, normalizeWebhooks, webhookUrlProblem } from '../../server/channels/webhookConfig';
import { replyRefusal } from '../../server/layers/gates';
import { routerSystemPrompt } from '../../server/layers/prompts';
import type { Worker } from '../../shared/types';

const STACK = 'TypeError: x is undefined\n    at render (src/app.js:12:5)\n    at main (src/index.js:3:1)';
const DIFF = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-a\n+b';
const LOG = '2026-11-02T10:00:01 starting\n2026-11-02T10:00:02 listening on 3000';

describe('the chat profile', () => {
  it('takes short replies of the three kinds', () => {
    expect(chatRefusal('On it: Pixel is on the header.')).toBeNull();
    expect(chatRefusal('Pixel finished the header; it is on the chat branch. Have a look?', 'acceptance')).toBeNull();
    expect(chatRefusal('Should the footer link to the blog?', 'question')).toBeNull();
    expect(chatRefusal('页脚要链接到博客吗？', 'question')).toBeNull();
    expect(isReplyKind('question')).toBe(true);
    expect(isReplyKind('status')).toBe(false);
  });

  it('keeps the word cap and its wording, and adds a line cap', () => {
    expect(replyRefusal('word '.repeat(100))).toBeNull();
    expect(replyRefusal('word '.repeat(101))).toMatch(/101 words; the chat takes at most 100/);
    expect(chatRefusal('one\ntwo\nthree\nfour\nfive\nsix')).toBeNull();
    expect(chatRefusal('one\ntwo\nthree\nfour\nfive\nsix\nseven')).toMatch(/7 lines; the chat takes at most 6/);
  });

  it('refuses tool output however short', () => {
    expect(chatRefusal(`It failed:\n${STACK}`)).toMatch(/a stack trace/);
    expect(chatRefusal('Traceback (most recent call last):')).toMatch(/a stack trace/);
    expect(chatRefusal(`Here is the change:\n${DIFF}`)).toMatch(/a diff/);
    expect(chatRefusal('Output:\n```\nok\n```')).toMatch(/a code block/);
    expect(chatRefusal(LOG)).toMatch(/log output/);
    expect(chatRefusal('npm ERR! code ERESOLVE')).toMatch(/log output/);
    expect(chatRefusal('$ npm test')).toMatch(/a shell transcript/);
    expect(chatRefusal('Crew noticed: <untrusted source="preview-console">boom</untrusted>')).toMatch(/prompt tags/);
    expect(chatRefusal(`Bundle: ${'a'.repeat(130)}`)).toMatch(/120 characters/);
    // The refusal points at the attached report, so the retry is a sentence, not a paraphrase.
    expect(chatRefusal(STACK)).toMatch(/attached under Details/);
  });

  it('sees tool output flattened into one line too, as a report cut to its first words reads', () => {
    const flat = (t: string) => t.replace(/\s+/g, ' ');
    expect(chatRefusal(flat(`Pixel reports: Fixed it. \`\`\`\nok\n\`\`\` All green.`))).toMatch(/a code block/);
    expect(chatRefusal(flat(`Pixel reports: ${STACK}`))).toMatch(/a stack trace/);
    expect(chatRefusal(flat(`Pixel reports: ${DIFF}`))).toMatch(/a diff/);
    expect(chatRefusal(flat(`Pixel reports: 2026-11-02T10:00:04 ERROR header.test.js failed`))).toMatch(/log output/);
    expect(chatRefusal('It said <tool_use_error>No such tool</tool_use_error>')).toMatch(/prompt tags/);
    expect(webhookText(flat(`Done. \`\`\`\nSECRET\n\`\`\``))).toBe('');
  });

  it('lets inline code, links and ordinary times through', () => {
    expect(chatRefusal('Run `npm test` after pulling; see `src/app.js`.')).toBeNull();
    expect(chatRefusal(`The PR is at https://github.com/acme/site/pull/12?${'x'.repeat(130)}`)).toBeNull();
    expect(chatRefusal('Meeting at 10:30, then I will check the footer.')).toBeNull();
    expect(chatRefusal('- header done\n- footer next')).toBeNull();
    expect(toolOutputIn('INFO is in the footer now.')).toBeNull();
  });

  it('wants a question mark on a question', () => {
    expect(chatRefusal('Tell me which colour.', 'question')).toMatch(/question mark/);
  });

  it('tells the Router about kinds, tool output and details', () => {
    const p = routerSystemPrompt({ lead: 'Chief', leadTitle: 'Lead', chat: 'Site', role: '', team: [], maxWorkers: 3 });
    expect(p).toContain('question (something only the user can answer)');
    expect(p).toContain('Never paste code, logs, diffs or other tool output');
    expect(p).toContain('attached to your reply under Details');
  });
});

describe("a Worker report's gist", () => {
  it('keeps the first sentences and drops code, output and markup', () => {
    const report = [
      '## Result',
      'Made the header **blue** and fixed the overlap on mobile. Checked it at three widths.',
      '```',
      '$ npm test',
      'ok 12 tests',
      '```',
      STACK,
      '- Files: src/header.css',
    ].join('\n');
    expect(reportGist(report)).toBe('Made the header blue and fixed the overlap on mobile. Checked it at three widths. Files: src/header.css');
    expect(reportGist(report, 10)).toBe('Made the header blue and fixed the overlap on mobile.');
    expect(reportGist('word '.repeat(80))).toMatch(/^word( word){29} …$/);
    expect(reportGist('```\nonly code\n```')).toBe('');
  });

  it('becomes a Details row that keeps the full report', () => {
    const w = { id: 'wk_1', title: 'Header', report: { at: 5, status: 'done', text: `Done. ${'x '.repeat(20)}` } } as unknown as Worker;
    expect(reportDetail(w, 'Pixel', 'Crew merged its changes.')).toEqual({
      workerId: 'wk_1',
      title: 'Header',
      bot: 'Pixel',
      status: 'done',
      gist: expect.stringMatching(/^Done\./),
      report: w.report?.text,
      landing: 'Crew merged its changes.',
      at: 5,
    });
    const long = { ...w, report: { at: 5, status: 'done', text: 'y'.repeat(30_000) } } as Worker;
    expect(reportDetail(long, 'Pixel')?.report).toMatch(/^y{20000}\n\n… \(cut/);
    expect(reportDetail({ ...w, report: undefined } as Worker, 'Pixel')).toBeNull();
    expect(reportDetail({ ...w, report: { at: 1, status: 'error', text: '' } } as Worker, 'Pixel')?.gist).toBe('Ended (error).');
  });
});

describe('the asynchronous profiles', () => {
  const longProse = 'This change does a thing for a reason that matters. '.repeat(8);

  it('maps draft kinds to profiles', () => {
    expect(asyncProfileFor('pr-open')).toBe('pull-request');
    expect(asyncProfileFor('issue-open')).toBe('issue');
    expect(asyncProfileFor('issue-comment')).toBe('comment');
    expect(asyncProfileFor('message', '#releases')).toBe('release-notes');
    expect(asyncProfileFor('message', 'CHANGELOG list')).toBe('release-notes');
    expect(asyncProfileFor('message', '#team')).toBe('message');
    expect(asyncProfileFor('git-push')).toBeNull();
  });

  it('wants a long PR description in sections, with a test section', () => {
    expect(asyncRefusal('pull-request', 'Fixes the header overlap.')).toBeNull();
    expect(asyncRefusal('pull-request', longProse)).toMatch(/## Testing section is required/);
    expect(asyncRefusal('pull-request', `## Summary\n${longProse}\n## Changes\n- header`)).toMatch(/Testing/);
    expect(asyncRefusal('pull-request', `## Summary\n${longProse}\n## Test plan\nRan npm test: 12 passed.`)).toBeNull();
  });

  it('wants structure in long issues and lists in release notes', () => {
    expect(asyncRefusal('issue', longProse)).toMatch(/needs structure/);
    expect(asyncRefusal('issue', `${longProse}\n- Steps: open /pricing`)).toBeNull();
    expect(asyncRefusal('release-notes', longProse)).toMatch(/lists/);
    expect(asyncRefusal('release-notes', `v1.2 is out.\n\n### Fixed\n- ${longProse}`)).toBeNull();
    expect(asyncRefusal('comment', longProse)).toBeNull();
  });

  it('takes tool output only inside a fence, and never prompt tags', () => {
    expect(asyncRefusal('pull-request', `It failed:\n${STACK}`)).toMatch(/stack trace outside a code block/);
    expect(asyncRefusal('pull-request', `It failed:\n\`\`\`\n${STACK}\n\`\`\``)).toBeNull();
    expect(asyncRefusal('issue', '<untrusted source="page">x</untrusted>')).toMatch(/prompt tags/);
    // A message goes to a chat: the chat rule, no output at all.
    expect(asyncRefusal('message', `Shipped.\n\`\`\`\n${LOG}\n\`\`\``)).toMatch(/goes to a chat: it takes no a code block/);
    expect(asyncRefusal('message', 'Shipped the header fix.')).toBeNull();
  });

  it('caps words outside code blocks', () => {
    expect(asyncRefusal('comment', 'word '.repeat(601))).toMatch(/601 words outside code blocks; a comment takes at most 600/);
    expect(asyncRefusal('comment', `Short.\n\`\`\`\n${'log '.repeat(2000)}\n\`\`\``)).toBeNull();
    expect(asyncRefusal('message', 'word '.repeat(151))).toMatch(/at most 150/);
  });

  it('tidies whitespace and folds long output', () => {
    const out = Array.from({ length: FOLD_LINES + 5 }, (_, i) => `line ${i}`).join('\n');
    const shaped = shapeAsync('pull-request', `## Summary  \nFix.\n\n\n\n## Testing\n\`\`\`\n${out}\n\`\`\`\n\nShort:\n\`\`\`\nok\n\`\`\``);
    expect(shaped).toContain('## Summary\nFix.\n\n## Testing');
    expect(shaped).toContain(`<details><summary>Output (${FOLD_LINES + 5} lines)</summary>\n\n\`\`\`\nline 0`);
    expect(shaped).toMatch(/line 19\n```\n\n<\/details>/);
    // A short block stays as it is; an agent's own fold is kept; shaping twice changes nothing.
    expect(shaped).toContain('Short:\n```\nok\n```');
    expect(shapeAsync('pull-request', shaped)).toBe(shaped);
    expect(shapeAsync('message', `a\n\n\n\nb  `)).toBe('a\n\nb');
  });
});

describe('the webhook channel', () => {
  it('sends only the words of a reply, never code, output or long inline code', () => {
    expect(webhookText('Pixel finished the header. Take a look?')).toBe('Pixel finished the header. Take a look?');
    const leaky = `Done.\n\`\`\`\nSECRET_FILE_CONTENT\n\`\`\`\n${STACK}\nSee \`${'const a = 1; '.repeat(5)}\` and \`npm test\`.`;
    const sent = webhookText(leaky);
    expect(sent).not.toContain('SECRET_FILE_CONTENT');
    expect(sent).not.toContain('src/app.js:12');
    expect(sent).not.toContain('const a');
    expect(sent).toContain('Done.');
    expect(sent).toContain('`npm test`');
    expect(webhookText('word '.repeat(150)).split(' ').length).toBeLessThanOrEqual(101);
  });

  it('builds Slack and Feishu payloads', () => {
    const text = notificationText({ project: 'Site', chat: 'Launch', speaker: 'Chief', kind: 'question', text: 'Ship it?' });
    expect(text).toBe('Question · Chief in "Launch" (Site):\nShip it?');
    expect(webhookPayload('slack', text)).toEqual({ text });
    expect(webhookPayload('feishu', text)).toEqual({ msg_type: 'text', content: { text } });
  });

  it('stores only valid hooks, off unless turned on, and shows a masked URL', () => {
    expect(webhookUrlProblem('ftp://x')).toMatch(/https/);
    expect(webhookUrlProblem('https://user:pw@hooks.slack.com/x')).toMatch(/user name/);
    expect(webhookUrlProblem('not a url')).toMatch(/URL/);
    expect(normalizeWebhook({ url: 'https://hooks.slack.com/services/T/B/secret' })).toEqual({
      url: 'https://hooks.slack.com/services/T/B/secret',
      format: 'slack',
      enabled: false,
      kinds: ['question', 'acceptance'],
    });
    expect(normalizeWebhook({ url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc', format: 'feishu', enabled: true, kinds: ['decision', 'nope'] })).toMatchObject({
      format: 'feishu',
      enabled: true,
      kinds: ['decision'],
    });
    expect(normalizeWebhooks({ p1: { url: 'bad' }, p2: { url: 'http://127.0.0.1:9/x' }, p3: 'x' })).toEqual({ p2: expect.objectContaining({ enabled: false }) });
    expect(maskUrl('https://hooks.slack.com/services/T/B/secret')).toEqual({ host: 'hooks.slack.com', masked: 'https://hooks.slack.com/services/…' });
  });
});
