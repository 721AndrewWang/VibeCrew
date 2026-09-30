import { useMemo, useState } from 'react';
import { diffLines } from 'diff';

interface Row {
  kind: 'ctx' | 'add' | 'del' | 'gap';
  a?: number;
  b?: number;
  text: string;
  hidden?: number;
}

const CONTEXT = 3;

function buildRows(before: string, after: string): Row[] {
  const rows: Row[] = [];
  let a = 1;
  let b = 1;
  for (const part of diffLines(before, after)) {
    const lines = part.value.replace(/\n$/, '').split('\n');
    for (const text of lines) {
      if (part.added) rows.push({ kind: 'add', b: b++, text });
      else if (part.removed) rows.push({ kind: 'del', a: a++, text });
      else rows.push({ kind: 'ctx', a: a++, b: b++, text });
    }
  }
  // Collapse long unchanged stretches.
  const out: Row[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== 'ctx') {
      out.push(rows[i++]);
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].kind === 'ctx') j++;
    const run = rows.slice(i, j);
    const lead = i === 0 ? 0 : CONTEXT;
    const tail = j === rows.length ? 0 : CONTEXT;
    if (run.length > lead + tail + 2) {
      out.push(...run.slice(0, lead));
      out.push({ kind: 'gap', text: '', hidden: run.length - lead - tail });
      out.push(...run.slice(run.length - tail));
    } else out.push(...run);
    i = j;
  }
  return out;
}

export function DiffView({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => buildRows(before, after), [before, after]);
  const [full, setFull] = useState(false);
  const allRows = useMemo(() => (full ? buildRowsFull(before, after) : rows), [full, rows, before, after]);
  const added = rows.filter((r) => r.kind === 'add').length;
  const removed = rows.filter((r) => r.kind === 'del').length;
  return (
    <div className="diff">
      <div className="diff-stats">
        <span className="add">+{added}</span>
        <span className="del">−{removed}</span>
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => setFull(!full)}>
          {full ? '折叠未改动的行' : '显示完整文件'}
        </button>
      </div>
      <div className="diff-body">
        {allRows.map((r, i) =>
          r.kind === 'gap' ? (
            <div key={i} className="diff-gap" onClick={() => setFull(true)}>
              ⋯ {r.hidden} 行未改动
            </div>
          ) : (
            <div key={i} className={`diff-row ${r.kind}`}>
              <span className="ln">{r.a ?? ''}</span>
              <span className="ln">{r.b ?? ''}</span>
              <span className="sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</span>
              <span className="code">{r.text || ' '}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function buildRowsFull(before: string, after: string): Row[] {
  const rows: Row[] = [];
  let a = 1;
  let b = 1;
  for (const part of diffLines(before, after)) {
    for (const text of part.value.replace(/\n$/, '').split('\n')) {
      if (part.added) rows.push({ kind: 'add', b: b++, text });
      else if (part.removed) rows.push({ kind: 'del', a: a++, text });
      else rows.push({ kind: 'ctx', a: a++, b: b++, text });
    }
  }
  return rows;
}

/** Renders `git diff` output. */
export function UnifiedDiff({ text }: { text: string }) {
  const lines = text.split('\n').filter((l) => !/^(diff --git|index |new file mode|deleted file mode|similarity|rename )/.test(l));
  if (!text.trim()) return <div className="muted" style={{ padding: 12 }}>没有差异</div>;
  return (
    <div className="diff">
      <div className="diff-body">
        {lines.map((l, i) => {
          const kind = l.startsWith('+++') || l.startsWith('---') ? 'meta' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx';
          return (
            <div key={i} className={`diff-row ${kind}`}>
              <span className="code">{l || ' '}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
