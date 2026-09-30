import { useMemo, useState } from 'react';
import { ArrowLeft, Info, Play, Plus, Save, Search, Trash2 } from 'lucide-react';
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
    toast('没有打开的对话', '先在左侧打开一个对话，再来试用技能', 'warn');
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
      toast('技能名不合法', '只能包含小写字母、数字和连字符，且以字母或数字开头（最多 40 个字符）', 'error');
      return;
    }
    if (!f.body.trim()) {
      toast('技能内容不能为空', undefined, 'error');
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
      toast(isNew ? `已创建 /${saved.name}` : `已保存 /${saved.name}`, undefined, 'success');
      onSaved(saved.name);
    } catch (e) {
      toast('保存失败', (e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!skill) return;
    const ok = await confirmDialog({
      title: `删除技能 /${skill.name}？`,
      body: '删除后无法恢复。如果它覆盖了同名的内置技能，会恢复为内置版本。',
      ok: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteSkill(skill.name);
      toast(`已删除 /${skill.name}`, undefined, 'success');
      onDeleted();
    } catch (e) {
      toast('删除失败', (e as Error).message, 'error');
    }
  };

  return (
    <div className="card skill-editor">
      <div className="se-head">
        <button className="icon-btn split-back" onClick={onBack} aria-label="返回列表">
          <ArrowLeft size={18} />
        </button>
        <span className="se-icon">
          <Glyph emoji={f.icon || '⚡'} size={22} />
        </span>
        <div className="se-title">
          <div className="se-cmd mono">/{f.name || '新技能'}</div>
          <div className="muted">{isNew ? '新建技能' : skill.builtin ? '内置技能' : '自定义技能'}</div>
        </div>
        <span className="spacer" />
        {skill && (
          <button className="btn sm" onClick={() => trySkill(skill.name)} title="在当前对话的输入框里填入这个命令">
            <Play size={13} /> 在当前对话中试用
          </button>
        )}
      </div>

      {skill?.builtin && (
        <div className="note accent">
          <Info size={14} />
          <span>这是内置技能。保存修改会创建一个同名的自定义版本来覆盖它；删除那个自定义版本就能恢复原样。</span>
        </div>
      )}

      <div className="form-grid">
        <div className="field">
          <label>命令名</label>
          <div className="input-prefix">
            <span className="mono">/</span>
            <input className={cx('input mono', f.name && !nameOk && 'invalid')} value={f.name} placeholder="my-skill" onChange={(e) => set({ name: slugify(e.target.value) })} />
          </div>
          <div className={cx('hint', f.name && !nameOk && 'error-text')}>小写字母、数字和连字符，例如 fix-console</div>
        </div>
        <div className="field">
          <label>标题</label>
          <div className="row">
            <input className="input emoji-input" value={f.icon} maxLength={8} title="图标（emoji）" onChange={(e) => set({ icon: e.target.value })} />
            <input className="input" value={f.title} placeholder="例如 修复控制台报错" onChange={(e) => set({ title: e.target.value })} />
          </div>
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label>说明</label>
          <input className="input" value={f.description} placeholder="一句话说明它做什么（显示在 / 菜单里）" onChange={(e) => set({ description: e.target.value })} />
        </div>
        <div className="field">
          <label>参数提示</label>
          <input className="input" value={f.argsHint} placeholder="例如 页面路径（可选）" onChange={(e) => set({ argsHint: e.target.value })} />
        </div>
      </div>
      <div className="field">
        <label>技能内容（发给机器人的提示词）</label>
        <textarea
          className="textarea mono tall"
          spellCheck={false}
          value={f.body}
          placeholder={'例如：\n检查 {{args}} 页面在手机、平板和桌面上的布局：\n1. 用 preview_screenshot 分别截图\n2. 找出错位、溢出和过小的点击区域\n3. 修复后再次截图确认'}
          onChange={(e) => set({ body: e.target.value })}
        />
        <div className="hint">
          用 <code className="inline-code">{'{{args}}'}</code> 代表命令后面输入的内容；没写 <code className="inline-code">{'{{args}}'}</code> 时，补充内容会附在末尾
        </div>
      </div>

      <div className="row se-actions">
        {skill && !skill.builtin && (
          <button className="btn danger" onClick={remove}>
            <Trash2 size={14} /> 删除
          </button>
        )}
        <span className="spacer" />
        {!isNew && dirty && <span className="muted se-dirty">有未保存的修改</span>}
        <button className="btn primary" disabled={saving || (!isNew && !dirty)} onClick={save}>
          {saving ? <span className="spinner" /> : <Save size={14} />} {isNew ? '创建技能' : skill.builtin ? '保存为自定义版本' : '保存'}
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
        <PageHead title="技能" sub="斜杠命令：在输入框输入 / 就能调用。把常用流程和团队规范沉淀成技能，所有机器人都能用">
          <button className="btn primary" onClick={() => setSelected(NEW)}>
            <Plus size={15} /> 新建技能
          </button>
        </PageHead>

        <div className={cx('split', showEditor && 'has-sel')}>
          <div className="split-list">
            <div className="list-search">
              <Search size={14} />
              <input placeholder="搜索技能" value={query} onChange={(e) => setQuery(e.target.value)} />
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
                  <span className={cx('badge', s.builtin ? '' : 'accent')}>{s.builtin ? '内置' : '自定义'}</span>
                </button>
              ))}
              {selected === NEW && (
                <button className="skill-item on">
                  <span className="si-icon">
                    <Glyph emoji="✨" size={17} />
                  </span>
                  <div className="si-text">
                    <div className="si-cmd mono">新技能</div>
                    <div className="si-title">未保存</div>
                  </div>
                </button>
              )}
              {!filtered.length && selected !== NEW && <div className="empty">没有匹配的技能</div>}
            </div>
            <div className="tip-card">
              <Glyph emoji="💡" size={13} /> 在浏览器预览里点「录制演示」，可以一键把演示变成技能（类似 Grokbot 的 Teach a task）
            </div>
          </div>

          <div className="split-main">
            {showEditor ? (
              <SkillEditor
                key={selected!}
                skill={current}
                onSaved={(name) => setSelected(name)}
                onDeleted={() => setSelected(null)}
                onBack={() => setSelected(null)}
              />
            ) : (
              <div className="card empty">
                <div className="big">
                  <Glyph emoji="⚡" size={26} />
                </div>
                <h3>选择一个技能</h3>
                <div>在左侧选择技能查看和修改，或者新建一个。</div>
                <button className="btn primary" onClick={() => setSelected(NEW)}>
                  <Plus size={15} /> 新建技能
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
