import { useMemo } from 'react';
import { Brain, Check, ChevronDown, Eye, Hand, Pencil, Rocket, ShieldCheck, Sparkles, type LucideIcon } from 'lucide-react';
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
    toast('没能切换', (e as Error).message, 'error');
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
  chat[key] === undefined ? [] : [{ separator: true }, { label: '恢复各机器人自己的设置', onClick: () => void save(chat, { [key]: null }) }];

export function ModeSwitch({ chat }: { chat: Chat }) {
  const list = useChatBots(chat);
  // Read-only bots keep their role whatever the switch says (see effectiveBot on the server).
  const readOnly = list.filter((b) => b.permission === 'plan');
  const working = list.filter((b) => b.permission !== 'plan');
  const value = working.length ? chat.permission || shared(working, (b) => b.permission) : 'plan';
  const Icon = value ? MODE_ICON[value] : ShieldCheck;
  const items = (): MenuItem[] => [
    { heading: readOnly.length && working.length ? `这个对话里机器人的权限（${readOnly.map((b) => b.name).join('、')} 是只读角色，保持只读）` : '这个对话里机器人的权限' },
    ...MODE_ORDER.map((m) => item(PERMISSION_INFO[m].label, PERMISSION_INFO[m].desc, chat.permission === m || (!chat.permission && value === m), () => void save(chat, { permission: m }), MODE_ICON[m])),
    ...resetItem(chat, 'permission'),
  ];
  return (
    <MenuButton className={cx('switch-pill', value === 'auto' && 'warn')} title="权限模式：机器人什么时候需要问你" items={items} align="left">
      <Icon size={14} />
      <span>{value ? PERMISSION_INFO[value].label : '各自设置'}</span>
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
    if (!viaProvider) return claudeModels.map((m) => ({ id: m.id, label: m.id ? m.label.replace(/^Claude\s+/, '') : '默认模型' }));
    const p = settings.provider;
    const preset = providers.find((x) => x.id === p.preset);
    const ids = [...new Set([p.model, ...(preset?.models || []), p.fastModel].filter(Boolean))];
    return [{ id: '', label: '默认模型' }, ...ids.map((id) => ({ id, label: id }))];
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
  const label =
    value === undefined ? actual || '各自的模型' : value === '' ? (actual ? `默认 · ${actual}` : '默认模型') : models.find((m) => m.id === value)?.label || value;
  const items = (): MenuItem[] => [
    { heading: actual ? `这个对话用的模型（现在是 ${actual}）` : '这个对话用的模型' },
    ...models.map((m) =>
      item(
        m.label,
        m.id ? undefined : viaProvider ? `连接设置里的 ${settings.provider.model || '模型'}` : `跟随 Claude Code 的默认${actual && value === '' ? `（现在是 ${actual}）` : ''}`,
        value === m.id,
        () => void save(chat, { model: m.id }),
      ),
    ),
    ...resetItem(chat, 'model'),
  ];
  return (
    <MenuButton className="switch-pill secondary" title="模型" items={items} align="right">
      <Sparkles size={14} />
      <span>{label}</span>
      <ChevronDown size={12} className="chev" />
    </MenuButton>
  );
}

export function EffortSwitch({ chat }: { chat: Chat }) {
  const list = useChatBots(chat);
  const value = chat.effort !== undefined ? chat.effort : shared(list, (b) => b.effort || '');
  const label = value === undefined ? '各自' : EFFORT_OPTIONS.find((o) => o.id === value)?.label.replace(/（.*）/, '') || '默认';
  const items = (): MenuItem[] => [
    { heading: '思考强度：越高越仔细，也越慢' },
    ...EFFORT_OPTIONS.map((o) => item(o.label, undefined, value === o.id, () => void save(chat, { effort: o.id as Effort }))),
    ...resetItem(chat, 'effort'),
  ];
  return (
    <MenuButton className="switch-pill secondary" title="思考强度" items={items} align="right">
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
  const title = top ? `上下文已用 ${pct}%（${top.bot.name}：${tokens(top.u.used)} / ${tokens(top.u.max)}）` : '上下文用量：机器人回复后显示';
  const items = (): MenuItem[] => [
    { heading: '上下文用量（快满时会自动压缩旧内容）' },
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
      : [{ label: '还没有用量，机器人回复后显示', disabled: true }]),
    { separator: true },
    {
      label: '开始新话题（清空上下文）',
      onClick: async () => {
        if (await confirmDialog({ title: '开始新话题？', body: '机器人会忘记这个对话之前的上下文（聊天记录仍然保留）。切换到不相关的任务时这样做，回复会更快、更省用量。', ok: '开始新话题' }))
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
