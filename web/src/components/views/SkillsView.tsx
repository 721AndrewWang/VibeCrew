import { ArrowLeft, Info, Play, Plus, Save, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Skill } from '../../../../shared/types';
import { api } from '../../api';
import { openChat, setDraft, toast, useStore } from '../../store';
import { cx } from '../../utils';
import { confirmDialog, Glyph } from '../ui';
import { PageHead } from './BotsView';

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NEW = '__new__';

function slugify(v: string) {
  return v
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 40);
}

export function trySkill(name: string) {
  const id = useStore.getState().activeChatId;
  if (!id || !useStore.getState().chats[id]) {
    toast('No chat open', 'Open a chat on the left first, then try the skill', 'warn');
    return;
  }
  setDraft(id, { text: '/' + name + ' ' });
  openChat(id);
}

interface Form {
  name: string;
  title: string;
  icon: string;
  argsHint: string;
  description: string;
  body: string;
}

const EMPTY: Form = { name: '', title: '', icon: '⚡', argsHint: '', description: '', body: '' };

function SkillEditor({ skill, onSaved, onDeleted, onBack }: { skill: Skill | null; onSaved: (name: string) => void; onDeleted: () => void; onBack: () => void }) {
  const [f, setF] = useState<Form>(() =>
    skill ? { name: skill.name, title: skill.title, icon: skill.icon, argsHint: skill.argsHint || '', description: skill.description, body: skill.body } : EMPTY,
  );
  const [saving, setSaving] = useState(false);
  const isNew = !skill;
  const nameOk = SKILL_NAME_RE.test(f.name);
  const dirty = skill
    ? f.name !== skill.name || f.title !== skill.title || f.icon !== skill.icon || f.argsHint !== (skill.argsHint || '') || f.description !== skill.description || f.body !== skill.body
    : true;
  const set = (p: Partial<Form>) => setF((cur) => ({ ...cur, ...p }));

  const save = async () => {
    if (!nameOk) {
      toast('Invalid skill name', 'Use only lowercase letters, digits and hyphens, starting with a letter or digit (max 40 characters)', 'error');
      return;
    }
    if (!f.body.trim()) {
      toast('Skill content cannot be empty', undefined, 'error');
      return;
    }
    setSaving(true);
    try {
      const saved = await api.saveSkill({
        name: f.name,
        title: f.title.trim() || f.name,
        icon: f.icon.trim() || '⚡',
        argsHint: f.argsHint,
        description: f.description,
        body: f.body,
        previousName: skill && !skill.builtin ? skill.name : undefined,
      });
      // Apply locally right away (the server does not announce the old name when a skill is renamed).
      const prev = skill && !skill.builtin ? skill.name : null;
      useStore.setState((s) => ({ skills: [...s.skills.filter((k) => k.name !== saved.name && k.name !== prev), saved] }));
      toast(isNew ? `Created /${saved.name}` : `Saved /${saved.name}`, undefined, 'success');
      onSaved(saved.name);
    } catch (e) {
      toast('Save failed', (e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!skill) return;
    const ok = await confirmDialog({
      title: `Delete skill /${skill.name}?`,
      body: "This can't be undone. If it overrides a built-in skill with the same name, the built-in version comes back.",
      ok: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteSkill(skill.name);
      toast(`Deleted /${skill.name}`, undefined, 'success');
      onDeleted();
    } catch (e) {
      toast('Delete failed', (e as Error).message, 'error');
    }
  };

  return (
    <div className="card skill-editor">
      <div className="se-head">
        <button className="icon-btn split-back" onClick={onBack} aria-label="Back to list">
          <ArrowLeft size={18} />
        </button>
        <span className="se-icon">
          <Glyph emoji={f.icon || '⚡'} size={22} />
        </span>
        <div className="se-title">
          <div className="se-cmd mono">/{f.name || 'new-skill'}</div>
          <div className="muted">{isNew ? 'New skill' : skill.builtin ? 'Built-in skill' : 'Custom skill'}</div>
        </div>
        <span className="spacer" />
        {skill && (
          <button className="btn sm" onClick={() => trySkill(skill.name)} title="Fills this command into the current chat's input box">
            <Play size={13} /> Try in current chat
          </button>
        )}
      </div>

      {skill?.builtin && (
        <div className="note accent">
          <Info size={14} />
          <span>This is a built-in skill. Saving changes creates a custom version with the same name that overrides it; delete that custom version to restore the original.</span>
        </div>
      )}

      <div className="form-grid">
        <div className="field">
          <label>Command name</label>
          <div className="input-prefix">
            <span className="mono">/</span>
            <input className={cx('input mono', f.name && !nameOk && 'invalid')} value={f.name} placeholder="my-skill" onChange={(e) => set({ name: slugify(e.target.value) })} />
          </div>
          <div className={cx('hint', f.name && !nameOk && 'error-text')}>Lowercase letters, digits and hyphens, e.g. fix-console</div>
        </div>
        <div className="field">
          <label>Title</label>
          <div className="row">
            <input className="input emoji-input" value={f.icon} maxLength={8} title="Icon (emoji)" onChange={(e) => set({ icon: e.target.value })} />
            <input className="input" value={f.title} placeholder="e.g. Fix console errors" onChange={(e) => set({ title: e.target.value })} />
          </div>
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label>Description</label>
          <input className="input" value={f.description} placeholder="One line on what it does (shown in the / menu)" onChange={(e) => set({ description: e.target.value })} />
        </div>
        <div className="field">
          <label>Argument hint</label>
          <input className="input" value={f.argsHint} placeholder="e.g. page path (optional)" onChange={(e) => set({ argsHint: e.target.value })} />
        </div>
      </div>
      <div className="field">
        <label>Skill content (the prompt sent to the bot)</label>
        <textarea
          className="textarea mono tall"
          spellCheck={false}
          value={f.body}
          placeholder={
            'For example:\nCheck the layout of the {{args}} page on phone, tablet and desktop:\n1. Take a screenshot of each with preview_screenshot\n2. Find misalignment, overflow and tap targets that are too small\n3. Fix them, then screenshot again to confirm'
          }
          onChange={(e) => set({ body: e.target.value })}
        />
        <div className="hint">
          Use <code className="inline-code">{'{{args}}'}</code> for whatever is typed after the command; without <code className="inline-code">{'{{args}}'}</code>, that text is appended at the end
        </div>
      </div>

      <div className="row se-actions">
        {skill && !skill.builtin && (
          <button className="btn danger" onClick={remove}>
            <Trash2 size={14} /> Delete
          </button>
        )}
        <span className="spacer" />
        {!isNew && dirty && <span className="muted se-dirty">Unsaved changes</span>}
        <button className="btn primary" disabled={saving || (!isNew && !dirty)} onClick={save}>
          {saving ? <span className="spinner" /> : <Save size={14} />} {isNew ? 'Create skill' : skill.builtin ? 'Save as custom version' : 'Save'}
        </button>
      </div>
    </div>
  );
}

export function SkillsView() {
  const skills = useStore((s) => s.skills);
  const list = useMemo(() => [...skills].sort((a, b) => a.name.localeCompare(b.name)), [skills]);
  // On wide screens, show the first skill straight away; on phones start with the list.
  const [selected, setSelected] = useState<string | null>(() => (window.innerWidth > 760 && list.length ? list[0].name : null));
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) => `${s.name} ${s.title} ${s.description}`.toLowerCase().includes(q));
  }, [list, query]);

  const current = selected && selected !== NEW ? list.find((s) => s.name === selected) || null : null;
  const showEditor = selected === NEW || !!current;

  return (
    <div className="page">
      <div className="page-inner">
        <PageHead title="Skills" sub="Slash commands: type / in the input box to use one. Capture common workflows and team conventions as skills any bot can use">
          <button className="btn primary" onClick={() => setSelected(NEW)}>
            <Plus size={15} /> New skill
          </button>
        </PageHead>

        <div className={cx('split', showEditor && 'has-sel')}>
          <div className="split-list">
            <div className="list-search">
              <Search size={14} />
              <input placeholder="Search skills" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="card list-card">
              {filtered.map((s) => (
                <button key={s.name} className={cx('skill-item', selected === s.name && 'on')} onClick={() => setSelected(s.name)}>
                  <span className="si-icon">
                    <Glyph emoji={s.icon} size={17} />
                  </span>
                  <div className="si-text">
                    <div className="si-cmd mono">/{s.name}</div>
                    <div className="si-title">{s.title}</div>
                  </div>
                  <span className={cx('badge', s.builtin ? '' : 'accent')}>{s.builtin ? 'Built-in' : 'Custom'}</span>
                </button>
              ))}
              {selected === NEW && (
                <button className="skill-item on">
                  <span className="si-icon">
                    <Glyph emoji="✨" size={17} />
                  </span>
                  <div className="si-text">
                    <div className="si-cmd mono">New skill</div>
                    <div className="si-title">Unsaved</div>
                  </div>
                </button>
              )}
              {!filtered.length && selected !== NEW && <div className="empty">No matching skills</div>}
            </div>
            <div className="tip-card">
              <Glyph emoji="💡" size={13} /> Click &quot;Record demo&quot; in the browser preview to turn a demo into a skill in one click (like Grokbot's Teach a task)
            </div>
          </div>

          <div className="split-main">
            {showEditor ? (
              <SkillEditor key={selected!} skill={current} onSaved={(name) => setSelected(name)} onDeleted={() => setSelected(null)} onBack={() => setSelected(null)} />
            ) : (
              <div className="card empty">
                <div className="big">
                  <Glyph emoji="⚡" size={26} />
                </div>
                <h3>Select a skill</h3>
                <div>Pick a skill on the left to view and edit it, or create a new one.</div>
                <button className="btn primary" onClick={() => setSelected(NEW)}>
                  <Plus size={15} /> New skill
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
