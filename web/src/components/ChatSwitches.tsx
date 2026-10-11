import { Brain, Check, ChevronDown, Eye, Hand, type LucideIcon, Pencil, Rocket, ShieldCheck, Sparkles } from 'lucide-react';
import { useMemo } from 'react';
import type { Bot, Chat, Effort, PermissionLevel } from '../../../shared/types';
import { api } from '../api';
import { toast, useStore } from '../store';
import { cx, EFFORT_OPTIONS, modelLabel, PERMISSION_INFO } from '../utils';
import { confirmDialog, MenuButton, type MenuItem } from './ui';

// Claude Code-style switches under the message box: permission mode, model and thinking effort for
// every bot in this chat. Unset, each bot uses its own settings (Bots page).

const MODE_ORDER: PermissionLevel[] = ['plan', 'ask', 'edits', 'review', 'auto'];
const MODE_ICON: Record<PermissionLevel, LucideIcon> = { plan: Eye, ask: Hand, edits: Pencil, review: ShieldCheck, auto: Rocket };
const CLAUDE_MODEL = /^claude-|^(opus|sonnet|haiku|fable)$/i;

type Switches = { permission?: PermissionLevel | null; model?: string | null; effort?: Effort | null };

async function save(chat: Chat, patch: Switches) {
  try {
    const next = await api.setChatSwitches(chat.id, patch);
    useStore.setState((s) => ({ chats: { ...s.chats, [chat.id]: next } }));
  } catch (e) {
    toast("Couldn't switch", (e as Error).message, 'error');
  }
}

/** The value every bot in the chat shares, or undefined when they differ. */
function shared<T>(list: Bot[], pick: (b: Bot) => T): T | undefined {
  const values = [...new Set(list.map(pick))];
  return values.length === 1 ? values[0] : undefined;
}

function useChatBots(chat: Chat) {
  const bots = useStore((s) => s.bots);
  return useMemo(() => chat.botIds.map((id) => bots[id]).filter(Boolean) as Bot[], [chat.botIds, bots]);
}

const item = (label: string, desc: string | undefined, on: boolean, onClick: () => void, Icon?: LucideIcon): MenuItem => ({
  icon: Icon ? <Icon size={15} /> : undefined,
  label: (
    <span className="switch-item">
      <span>{label}</span>
      {desc && <span className="switch-desc">{desc}</span>}
    </span>
  ),
  hint: on ? <Check size={14} /> : undefined,
  onClick,
});

const resetItem = (chat: Chat, key: keyof Switches): MenuItem[] =>
  chat[key] === undefined ? [] : [{ separator: true }, { label: "Use each bot's own setting", onClick: () => void save(chat, { [key]: null }) }];

export function ModeSwitch({ chat }: { chat: Chat }) {
  const list = useChatBots(chat);
  // Read-only bots keep their role whatever the switch says (see effectiveBot on the server).
  const readOnly = list.filter((b) => b.permission === 'plan');
  const working = list.filter((b) => b.permission !== 'plan');
  const value = working.length ? chat.permission || shared(working, (b) => b.permission) : 'plan';
  const Icon = value ? MODE_ICON[value] : ShieldCheck;
  const items = (): MenuItem[] => [
    {
      heading:
        readOnly.length && working.length
          ? `Bot permissions in this chat (${readOnly.map((b) => b.name).join(', ')} ${readOnly.length === 1 ? 'is a read-only role and stays' : 'are read-only roles and stay'} read-only)`
          : 'Bot permissions in this chat',
    },
    ...MODE_ORDER.map((m) =>
      item(PERMISSION_INFO[m].label, PERMISSION_INFO[m].desc, chat.permission === m || (!chat.permission && value === m), () => void save(chat, { permission: m }), MODE_ICON[m]),
    ),
    ...resetItem(chat, 'permission'),
  ];
  return (
    <MenuButton className={cx('switch-pill', value === 'auto' && 'warn')} title="Permission mode: when bots need to ask you" items={items} align="left">
      <Icon size={14} />
      <span>{value ? PERMISSION_INFO[value].label : 'Per bot'}</span>
      <ChevronDown size={12} className="chev" />
    </MenuButton>
  );
}

export function ModelSwitch({ chat }: { chat: Chat }) {
  const list = useChatBots(chat);
  const claudeModels = useStore((s) => s.models);
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const viaProvider = settings.authMode === 'provider';
  const models = useMemo(() => {
    if (!viaProvider) return claudeModels.map((m) => ({ id: m.id, label: m.id ? m.label.replace(/^Claude\s+/, '') : 'Default model' }));
    const p = settings.provider;
    const preset = providers.find((x) => x.id === p.preset);
    const ids = [...new Set([p.model, ...(preset?.models || []), p.fastModel].filter(Boolean))];
    return [{ id: '', label: 'Default model' }, ...ids.map((id) => ({ id, label: id }))];
  }, [viaProvider, claudeModels, settings.provider, providers]);
  const raw = chat.model !== undefined ? chat.model : shared(list, (b) => b.model || '');
  // Another provider ignores a Claude model name and uses its own default.
  const value = raw !== undefined && viaProvider && CLAUDE_MODEL.test(raw) ? '' : raw;
  // What the bots' sessions actually run on (reported by Claude Code after a reply).
  const running = shared(
    list.filter((b) => chat.context?.[b.id]?.model),
    (b) => chat.context![b.id].model!,
  );
  const actual = running ? modelLabel(running) : '';
  const label = value === undefined ? actual || 'Per-bot model' : value === '' ? (actual ? `Default · ${actual}` : 'Default model') : models.find((m) => m.id === value)?.label || value;
  const items = (): MenuItem[] => [
    { heading: actual ? `Model for this chat (now ${actual})` : 'Model for this chat' },
    ...models.map((m) =>
      item(
        m.label,
        m.id ? undefined : viaProvider ? `${settings.provider.model || 'Model'} from connection settings` : `Follow Claude Code's default${actual && value === '' ? ` (now ${actual})` : ''}`,
        value === m.id,
        () => void save(chat, { model: m.id }),
      ),
    ),
    ...resetItem(chat, 'model'),
  ];
  return (
    <MenuButton className="switch-pill secondary" title="Model" items={items} align="right">
      <Sparkles size={14} />
      <span>{label}</span>
      <ChevronDown size={12} className="chev" />
    </MenuButton>
  );
}

export function EffortSwitch({ chat }: { chat: Chat }) {
  const list = useChatBots(chat);
  const value = chat.effort !== undefined ? chat.effort : shared(list, (b) => b.effort || '');
  const label = value === undefined ? 'Per bot' : EFFORT_OPTIONS.find((o) => o.id === value)?.label.replace(/\s*\(.*\)/, '') || 'Default';
  const items = (): MenuItem[] => [
    { heading: 'Effort: higher is more thorough, but slower' },
    ...EFFORT_OPTIONS.map((o) => item(o.label, undefined, value === o.id, () => void save(chat, { effort: o.id as Effort }))),
    ...resetItem(chat, 'effort'),
  ];
  return (
    <MenuButton className="switch-pill secondary" title="Effort" items={items} align="right">
      <Brain size={14} />
      <span>{label}</span>
      <ChevronDown size={12} className="chev" />
    </MenuButton>
  );
}

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/**
 * How full the bots' context windows are (Claude Code's /context), like the ring in Claude Code:
 * the fullest bot's share, each bot's numbers on click.
 */
export function ContextRing({ chat }: { chat: Chat }) {
  const list = useChatBots(chat);
  const rows = list
    .filter((b) => chat.context?.[b.id])
    .map((b) => ({ bot: b, u: chat.context![b.id] }))
    .sort((a, b) => b.u.percentage - a.u.percentage);
  const top = rows[0];
  const pct = top ? Math.max(0, Math.min(100, top.u.percentage)) : 0;
  const tone = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : '';
  const r = 7;
  const c = 2 * Math.PI * r;
  const title = top ? `Context used ${pct}% (${top.bot.name}: ${tokens(top.u.used)} / ${tokens(top.u.max)})` : 'Context usage: shown after a bot replies';
  const items = (): MenuItem[] => [
    { heading: 'Context usage (older content is compacted automatically when nearly full)' },
    ...(rows.length
      ? rows.map(({ bot, u }) => ({
          label: (
            <span className="ctx-row">
              <span>{bot.name}</span>
              <span className="muted">
                {tokens(u.used)} / {tokens(u.max)}
              </span>
            </span>
          ),
          hint: `${Math.min(100, u.percentage)}%`,
        }))
      : [{ label: 'No usage yet. Shown after a bot replies', disabled: true }]),
    { separator: true },
    {
      label: 'Start new topic (clear context)',
      onClick: async () => {
        if (
          await confirmDialog({
            title: 'Start new topic?',
            body: "Bots will forget this chat's earlier context (the chat history is kept). Do this when switching to an unrelated task: replies get faster and use less.",
            ok: 'Start new topic',
          })
        )
          void api.reset(chat.id);
      },
    },
  ];
  return (
    <MenuButton className={cx('ctx-ring', tone)} title={title} items={items} align="right">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <circle cx="9" cy="9" r={r} className="ctx-track" />
        {pct > 0 && <circle cx="9" cy="9" r={r} className="ctx-fill" strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 9 9)" />}
      </svg>
    </MenuButton>
  );
}
