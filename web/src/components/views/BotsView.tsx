import { ChevronLeft, Coins, FolderGit2, MessageCircle, MoreHorizontal, Plus, Puzzle, Scissors, Settings, Trash2, UserPlus, Users } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import type { Bot, ModelOption } from '../../../../shared/types';
import { api } from '../../api';
import { dmOf, openChat, openModal, toast, useStore } from '../../store';
import { cx, PERMISSION_INFO, statusLabel } from '../../utils';
import { Avatar, confirmDialog, Glyph, MenuButton } from '../ui';

/** Shared header for the management pages. */
export function PageHead({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <button className="icon-btn mobile-back" aria-label="返回" onClick={() => useStore.setState({ mobilePane: 'list' })}>
        <ChevronLeft size={22} />
      </button>
      <div className="ph-text">
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {children && <div className="ph-actions">{children}</div>}
    </div>
  );
}

export function modelLabel(models: { id: string; label: string }[], id: string) {
  if (!id) return '默认模型';
  return models.find((m) => m.id === id)?.label || id;
}

const TIER = { high: { mark: '$$$', title: '高档模型：最强，也最贵' }, mid: { mark: '$$', title: '中档模型：日常开发够用' }, low: { mark: '$', title: '便宜模型：简单任务' } } as const;

export function tierMark(models: ModelOption[], id: string) {
  const t = models.find((m) => m.id === id)?.tier;
  return t ? <span className="tier">{TIER[t].mark}</span> : null;
}
export function tierTitle(models: ModelOption[], id: string) {
  const t = models.find((m) => m.id === id)?.tier;
  return t ? TIER[t].title : undefined;
}

export function fmtUsd(n: number) {
  return n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

export async function deleteBotFlow(bot: Bot): Promise<boolean> {
  const ok = await confirmDialog({
    title: `删除机器人「${bot.name}」？`,
    body: '它的单聊记录、长期记忆和定时任务会一起删除，它也会离开所在的群聊。项目文件不受影响。',
    ok: '删除',
    danger: true,
  });
  if (!ok) return false;
  try {
    await api.deleteBot(bot.id);
    toast(`已删除 ${bot.name}`, undefined, 'success');
    return true;
  } catch (e) {
    toast('删除失败', (e as Error).message, 'error');
    return false;
  }
}

export function messageBot(botId: string) {
  const dm = dmOf(botId);
  if (dm) openChat(dm.id);
  else toast('找不到单聊', '稍后再试一次', 'warn');
}

const TONE_DOT: Record<string, string> = { idle: '', busy: 'green pulse', wait: 'orange pulse', error: 'red', queued: 'blue pulse' };

function BotCard({ bot }: { bot: Bot }) {
  const status = useStore((s) => s.statuses[bot.id]);
  const models = useStore((s) => s.models);
  const usage = useStore((s) => s.usage[bot.id]);
  const project = useStore((s) => (bot.projectId ? s.projects[bot.projectId] : undefined));
  const st = statusLabel(status);
  const perm = PERMISSION_INFO[bot.permission];
  return (
    <div className="card bot-card">
      <div className="bc-top">
        <button className="bc-avatar" onClick={() => openModal({ kind: 'botEditor', botId: bot.id })} title="设置">
          <Avatar bot={bot} size={52} status={status} />
        </button>
        <div className="bc-id">
          <div className="bc-name">{bot.name}</div>
          <div className="bc-title">{bot.title}</div>
        </div>
        <MenuButton
          title="更多"
          align="right"
          items={[
            { label: '设置', icon: <Settings size={15} />, onClick: () => openModal({ kind: 'botEditor', botId: bot.id }) },
            { separator: true },
            { label: '删除', icon: <Trash2 size={15} />, danger: true, onClick: () => void deleteBotFlow(bot) },
          ]}
        >
          <MoreHorizontal size={18} />
        </MenuButton>
      </div>
      <div className={cx('bc-status', `tone-${st.tone}`)}>
        <span className={cx('dot', TONE_DOT[st.tone])} />
        <span className="bc-status-text">{st.text}</span>
      </div>
      <div className="bc-badges">
        <span className="badge" title={perm.desc}>
          <Glyph emoji={perm.icon} size={11} /> {perm.label}
        </span>
        <span className="badge" title={tierTitle(models, bot.model)}>
          {modelLabel(models, bot.model)}
          {tierMark(models, bot.model)}
        </span>
        {bot.editScope?.length ? (
          <span className="badge" title={`只能修改：${bot.editScope.join('、')}`}>
            <Scissors size={11} /> 只改 {bot.editScope[0]}
            {bot.editScope.length > 1 ? ` 等 ${bot.editScope.length} 处` : ''}
          </span>
        ) : null}
        {usage?.month.turns ? (
          <span className="badge" title={`今天 ${fmtUsd(usage.today.costUsd)} · ${usage.today.turns} 轮`}>
            <Coins size={11} /> 本月 {fmtUsd(usage.month.costUsd)}
            {bot.monthlyBudgetUsd ? ` / ${fmtUsd(bot.monthlyBudgetUsd)}` : ''} · {usage.month.turns} 轮
          </span>
        ) : null}
        {bot.plugins.length > 0 && (
          <span className="badge accent">
            <Puzzle size={11} /> {bot.plugins.length} 个插件
          </span>
        )}
      </div>
      {project && (
        <div className="bc-project muted" title={project.path}>
          <FolderGit2 size={13} />
          <span>{project.name}</span>
        </div>
      )}
      <div className="bc-actions">
        <button className="btn primary sm" onClick={() => messageBot(bot.id)}>
          <MessageCircle size={14} /> 发消息
        </button>
        <button className="btn sm" onClick={() => openModal({ kind: 'botEditor', botId: bot.id })}>
          <Settings size={14} /> 设置
        </button>
      </div>
    </div>
  );
}

export function BotsView() {
  const bots = useStore((s) => s.bots);
  const list = useMemo(() => Object.values(bots).sort((a, b) => a.createdAt - b.createdAt), [bots]);

  return (
    <div className="page">
      <div className="page-inner">
        <PageHead title="机器人" sub="你的 AI 队友：每个机器人有自己的角色、权限、插件和长期记忆">
          <button className="btn" onClick={() => openModal({ kind: 'newGroup' })}>
            <Users size={15} /> 新建群聊
          </button>
          <button className="btn primary" onClick={() => openModal({ kind: 'newBot' })}>
            <UserPlus size={15} /> 新建机器人
          </button>
        </PageHead>

        {list.length === 0 ? (
          <div className="card empty">
            <div className="big">
              <Glyph emoji="🤖" size={26} />
            </div>
            <h3>还没有机器人</h3>
            <div>从模板添加一位前端工程师、测试工程师或代码审查员，组建你的 Web 开发小队。</div>
            <button className="btn primary" onClick={() => openModal({ kind: 'newBot' })}>
              <Plus size={15} /> 添加机器人
            </button>
          </div>
        ) : (
          <div className="bot-grid">
            {list.map((b) => (
              <BotCard key={b.id} bot={b} />
            ))}
            <button className="add-card" onClick={() => openModal({ kind: 'newBot' })}>
              <Plus size={22} />
              <span>添加机器人</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
