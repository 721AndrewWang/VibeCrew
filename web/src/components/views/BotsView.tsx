import { ChevronLeft, Coins, Database, FolderGit2, MessageCircle, MoreHorizontal, Plus, Puzzle, Scissors, Settings, Trash2, UserPlus, Users } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import type { Bot, BotUsage, ModelOption } from '../../../../shared/types';
import { api } from '../../api';
import { dmOf, openChat, openModal, toast, useStore } from '../../store';
import { cx, fmtTokens, PERMISSION_INFO, statusLabel } from '../../utils';
import { Avatar, confirmDialog, Glyph, MenuButton } from '../ui';
import { ImprovementsPanel } from './ImprovementsPanel';

/** Shared header for the management pages. */
export function PageHead({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <button className="icon-btn mobile-back" aria-label="Back" onClick={() => useStore.setState({ mobilePane: 'list' })}>
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
  if (!id) return 'Default model';
  return models.find((m) => m.id === id)?.label || id;
}

const TIER = {
  high: { mark: '$$$', title: 'Premium model: strongest and priciest' },
  mid: { mark: '$$', title: 'Mid-tier model: fine for everyday dev' },
  low: { mark: '$', title: 'Cheap model: simple tasks' },
} as const;

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
    title: `Delete bot "${bot.name}"?`,
    body: 'Its direct chat history, long-term memory and routines will be deleted too, and it will leave its group chats. Project files are not affected.',
    ok: 'Delete',
    danger: true,
  });
  if (!ok) return false;
  try {
    await api.deleteBot(bot.id);
    toast(`Deleted ${bot.name}`, undefined, 'success');
    return true;
  } catch (e) {
    toast('Delete failed', (e as Error).message, 'error');
    return false;
  }
}

export function messageBot(botId: string) {
  const dm = dmOf(botId);
  if (dm) openChat(dm.id);
  else toast('Direct chat not found', 'Try again later', 'warn');
}

const TONE_DOT: Record<string, string> = { idle: '', busy: 'green pulse', wait: 'orange pulse', error: 'red', queued: 'blue pulse' };

/**
 * How much of what the bot read came from the cache, and how much a turn re-reads on average: a
 * long turn re-reads its whole context at every tool call. Click to open the turn that read most.
 */
function CacheBadge({ usage }: { usage: BotUsage }) {
  const t = usage.tokens;
  const read = t.input + t.cacheRead + t.cacheWrite;
  const hit = read ? Math.round((t.cacheRead / read) * 100) : 0;
  const perTurn = t.cacheRead / usage.tokenTurns;
  const peak = usage.peak;
  const title = [
    `This month, ${usage.tokenTurns} turn${usage.tokenTurns === 1 ? '' : 's'}: read ${fmtTokens(read)} (cache hit ${fmtTokens(t.cacheRead)}, cache write ${fmtTokens(t.cacheWrite)}, uncached ${fmtTokens(t.input)}); output ${fmtTokens(t.output)}.`,
    'Every tool call in a turn rereads the context, so rereads mostly depend on how many steps a turn takes and how long the context is.',
    peak ? `Biggest reread in one turn: ${fmtTokens(peak.cacheRead)}. Click to open that chat.` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <button type="button" className="badge cache-badge" title={title} onClick={() => peak && openChat(peak.chatId)}>
      <Database size={11} /> Cache hit {hit}% · {fmtTokens(perTurn)} reread/turn
    </button>
  );
}

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
        <button className="bc-avatar" onClick={() => openModal({ kind: 'botEditor', botId: bot.id })} title="Settings">
          <Avatar bot={bot} size={52} status={status} />
        </button>
        <div className="bc-id">
          <div className="bc-name">{bot.name}</div>
          <div className="bc-title">{bot.title}</div>
        </div>
        <MenuButton
          title="More"
          align="right"
          items={[
            { label: 'Settings', icon: <Settings size={15} />, onClick: () => openModal({ kind: 'botEditor', botId: bot.id }) },
            { separator: true },
            { label: 'Delete', icon: <Trash2 size={15} />, danger: true, onClick: () => void deleteBotFlow(bot) },
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
          <span className="badge" title={`Can only edit: ${bot.editScope.join(', ')}`}>
            <Scissors size={11} /> Only edits {bot.editScope[0]}
            {bot.editScope.length > 1 ? ` +${bot.editScope.length - 1} more` : ''}
          </span>
        ) : null}
        {usage?.month.turns ? (
          <span className="badge" title={`Today ${fmtUsd(usage.today.costUsd)} · ${usage.today.turns} turn${usage.today.turns === 1 ? '' : 's'}`}>
            <Coins size={11} /> This month {fmtUsd(usage.month.costUsd)}
            {bot.monthlyBudgetUsd ? ` / ${fmtUsd(bot.monthlyBudgetUsd)}` : ''} · {usage.month.turns} turn{usage.month.turns === 1 ? '' : 's'}
          </span>
        ) : null}
        {usage?.month.tokenTurns ? <CacheBadge usage={usage.month} /> : null}
        {bot.plugins.length > 0 && (
          <span className="badge accent">
            <Puzzle size={11} /> {bot.plugins.length} plugin{bot.plugins.length === 1 ? '' : 's'}
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
          <MessageCircle size={14} /> Message
        </button>
        <button className="btn sm" onClick={() => openModal({ kind: 'botEditor', botId: bot.id })}>
          <Settings size={14} /> Settings
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
        <PageHead title="Bots" sub="Your AI teammates: each bot has its own role, permissions, plugins and long-term memory">
          <button className="btn" onClick={() => openModal({ kind: 'newGroup' })}>
            <Users size={15} /> New group chat
          </button>
          <button className="btn primary" onClick={() => openModal({ kind: 'newBot' })}>
            <UserPlus size={15} /> New bot
          </button>
        </PageHead>

        {list.length === 0 ? (
          <div className="card empty">
            <div className="big">
              <Glyph emoji="🤖" size={26} />
            </div>
            <h3>No bots yet</h3>
            <div>Add a frontend engineer, test engineer or code reviewer from a template to build your web dev team.</div>
            <button className="btn primary" onClick={() => openModal({ kind: 'newBot' })}>
              <Plus size={15} /> Add bot
            </button>
          </div>
        ) : (
          <>
            <ImprovementsPanel />
            <div className="bot-grid">
              {list.map((b) => (
                <BotCard key={b.id} bot={b} />
              ))}
              <button className="add-card" onClick={() => openModal({ kind: 'newBot' })}>
                <Plus size={22} />
                <span>Add bot</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
