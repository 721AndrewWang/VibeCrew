import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { Marked, type Tokens } from 'marked';
import { type MouseEvent, memo, useMemo } from 'react';
import { openFileInEditor, toast } from '../store';
import { copyText } from '../utils';

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code(token: Tokens.Code) {
      const lang = (token.lang || '').trim().split(/\s+/)[0];
      let html: string;
      try {
        html = lang && hljs.getLanguage(lang) ? hljs.highlight(token.text, { language: lang }).value : hljs.highlightAuto(token.text).value;
      } catch {
        html = escapeHtml(token.text);
      }
      return `<div class="code-block"><div class="code-head"><span>${escapeHtml(lang || 'code')}</span><button class="code-copy" type="button">Copy</button></div><pre><code class="hljs">${html}</code></pre></div>`;
    },
    link(token: Tokens.Link) {
      const text = this.parser.parseInline(token.tokens);
      return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});

const PATH_RE = /^(\.{0,2}\/)?[\w@.-]+(\/[\w@.[\]-]+)*\.[a-zA-Z0-9]{1,8}(:\d+(:\d+)?)?$/;

function render(text: string, names: string[]): string {
  const raw = md.parse(text, { async: false }) as string;
  const clean = DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] });
  if (!names.length && !clean.includes('<code>')) return clean;
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  // Inline code that looks like a file path opens in the editor.
  tpl.content.querySelectorAll('code').forEach((c) => {
    if (c.closest('pre')) return;
    if (PATH_RE.test(c.textContent || '')) c.classList.add('code-path');
  });
  if (names.length) {
    const re = new RegExp(`@(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}|all|everyone)(?![A-Za-z0-9_-])`, 'gi');
    const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) {
      const n = walker.currentNode as Text;
      if (n.parentElement?.closest('code, pre, a')) continue;
      if (re.test(n.data)) nodes.push(n);
      re.lastIndex = 0;
    }
    for (const n of nodes) {
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of n.data.matchAll(re)) {
        frag.append(n.data.slice(last, m.index));
        const span = document.createElement('span');
        span.className = 'mention';
        span.textContent = m[0];
        frag.append(span);
        last = m.index! + m[0].length;
      }
      frag.append(n.data.slice(last));
      n.replaceWith(frag);
    }
  }
  return tpl.innerHTML;
}

export const Markdown = memo(function Markdown({ text, names = [], projectId, className }: { text: string; names?: string[]; projectId?: string | null; className?: string }) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: names is a fresh array each render; its contents are the key
  const html = useMemo(() => render(text, names), [text, names.join('|')]);
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.classList.contains('code-copy')) {
      const code = t.closest('.code-block')?.querySelector('code')?.textContent || '';
      void copyText(code).then(() => {
        t.textContent = 'Copied';
        setTimeout(() => (t.textContent = 'Copy'), 1200);
      });
      return;
    }
    if (t.classList.contains('code-path') && projectId) {
      const p = (t.textContent || '').replace(/:\d+(:\d+)?$/, '').replace(/^\.\//, '');
      openFileInEditor(projectId, p);
      return;
    }
    if (t.classList.contains('code-path') && !projectId) toast('This chat has no linked project');
  };
  // biome-ignore lint/security/noDangerouslySetInnerHtml: rendered by marked, then run through DOMPurify
  return <div className={className ? `md ${className}` : 'md'} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
