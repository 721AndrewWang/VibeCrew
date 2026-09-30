import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { useDarkMode } from './theme';

function languageFor(path: string): Extension {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'html':
    case 'htm':
    case 'vue':
    case 'svelte':
    case 'astro':
      return html();
    case 'css':
    case 'scss':
    case 'less':
      return css();
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'ts':
    case 'mts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'json':
    case 'webmanifest':
      return json();
    case 'md':
    case 'mdx':
      return markdown();
    default:
      return [];
  }
}

const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-gutters': { border: 'none' },
});

const lightTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--bg-elev)' },
  '.cm-gutters': { backgroundColor: 'var(--bg-elev)', color: 'var(--text-3)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'rgba(10,132,255,0.06)' },
});

/** A CodeMirror editor. `value` replaces the document only when it changes from outside. */
export function CodeEditor({ path, value, onChange, onSave }: { path: string; value: string; onChange: (v: string) => void; onSave: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const themeComp = useRef(new Compartment());
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };
  const dark = useDarkMode();

  useEffect(() => {
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        languageFor(path),
        baseTheme,
        themeComp.current.of(dark ? oneDark : lightTheme),
        EditorView.lineWrapping,
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              cb.current.onSave();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cb.current.onChange(u.state.doc.toString());
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current! });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // A new file gets a fresh editor (language, undo history).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (cur !== value) v.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: themeComp.current.reconfigure(dark ? oneDark : lightTheme) });
  }, [dark]);

  return <div className="code-editor" ref={host} />;
}
