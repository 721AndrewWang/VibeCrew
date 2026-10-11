import fs from 'node:fs';
import type { Bot, Chat, Effort, PermissionLevel } from '../shared/types';
import { memoryFile } from './agents/prompts';
import { deleteTurns } from './agents/recorder';
import { bus } from './bus';
import { BOT_TEMPLATES, DEFAULT_ALLOW_RULES, DEFAULT_ASK_RULES, DEFAULT_TEAM } from './data/catalog';
import { logger } from './log';
import { applyChatSettings, forgetChat, invalidateBot, invalidateChat, isChatBusy, systemMessage } from './orchestrator';
import { createProject, HttpError, listProjects } from './projects';
import { bots, chats, messages, projects, routines, settings, uid } from './store';
import { detachWorkspace } from './workspaces';

const log = logger('init');

const NAME_RE = /^[\p{L}\p{N}_-]{1,24}$/u;

function checkName(name: string, selfId?: string) {
  if (!NAME_RE.test(name)) throw new HttpError(400, 'Names can only contain letters, numbers, underscores or hyphens (up to 24 characters), with no spaces');
  if (/^(all|everyone)$/i.test(name)) throw new HttpError(400, 'That name is reserved for @all / @everyone');
  const clash = bots.all().find((b) => b.id !== selfId && b.name.toLowerCase() === name.toLowerCase());
  if (clash) throw new HttpError(400, `There's already a bot called ${name}`);
}

function newChat(partial: Partial<Chat> & Pick<Chat, 'kind' | 'title' | 'botIds'>): Chat {
  const now = Date.now();
  return {
    id: uid('c_'),
    leadBotId: partial.botIds[0] ?? null,
    projectId: null,
    createdAt: now,
    updatedAt: now,
    unread: 0,
    sessions: {},
    cursors: {},
    seq: 0,
    maxHops: settings.get().maxHops,
    ...partial,
  };
}

/**
 * Moving a chat to another project or deleting it removes its workspace, which must not happen
 * under a running bot turn (or a merge in progress).
 */
export function assertWorkspaceIdle(chat: Chat | undefined) {
  if (chat?.workspaceId && isChatBusy(chat.id)) {
    throw new HttpError(409, `The bots in "${chat.title}" are working in its own workspace (or merging); wait for this turn to end`);
  }
}

export function dmOf(botId: string): Chat | undefined {
  return chats.all().find((c) => c.kind === 'dm' && c.botIds[0] === botId);
}

function ensureDm(bot: Bot): Chat {
  const existing = dmOf(bot.id);
  if (existing) return existing;
  const chat = newChat({ kind: 'dm', title: bot.name, botIds: [bot.id], projectId: bot.projectId });
  chats.set(chat);
  bus.emit({ t: 'chat', chat });
  return chat;
}

/** Trimmed, deduplicated globs, or undefined when there are none. */
function cleanScope(scope: string[] | undefined): string[] | undefined {
  const out = [...new Set((scope || []).map((g) => g.trim()).filter(Boolean))];
  return out.length ? out : undefined;
}

/** A request may send null to clear the budget. */
type BotInput = Partial<Omit<Bot, 'monthlyBudgetUsd'>> & { monthlyBudgetUsd?: number | null };

export function createBot(input: BotInput & { template?: string }): Bot {
  const tpl = BOT_TEMPLATES.find((t) => t.id === input.template);
  let name = (input.name ?? tpl?.name ?? '').trim();
  if (!name) throw new HttpError(400, 'Enter a name');
  if (tpl && !input.name) {
    // Templates may be added more than once: Pixel, Pixel2, …
    for (let i = 2; bots.all().some((b) => b.name.toLowerCase() === name.toLowerCase()); i++) name = `${tpl.name}${i}`;
  }
  checkName(name);
  const now = Date.now();
  const bot: Bot = {
    id: uid('b_'),
    name,
    emoji: input.emoji || tpl?.emoji || '🤖',
    color: input.color || tpl?.color || '#0a84ff',
    title: input.title?.trim() || tpl?.title || 'Web dev assistant',
    description: input.description?.trim() || tpl?.description || '',
    model: input.model ?? tpl?.model ?? '',
    effort: input.effort ?? tpl?.effort ?? '',
    permission: input.permission || tpl?.permission || settings.get().defaultPermission,
    allowRules: input.allowRules ?? [...DEFAULT_ALLOW_RULES, ...(tpl?.allowRules || [])],
    askRules: input.askRules ?? [...DEFAULT_ASK_RULES],
    mcpServers: input.mcpServers ?? {},
    plugins: input.plugins ?? tpl?.plugins ?? [],
    loadUserSettings: input.loadUserSettings ?? true,
    editScope: cleanScope(input.editScope) ?? (tpl?.editScope ? [...tpl.editScope] : undefined),
    monthlyBudgetUsd: input.monthlyBudgetUsd || undefined,
    freshSession: input.freshSession ?? tpl?.freshSession ?? undefined,
    blindReview: input.blindReview ?? tpl?.blindReview ?? undefined,
    projectId: input.projectId !== undefined ? input.projectId : (listProjects()[0]?.id ?? null),
    template: tpl?.id,
    createdAt: now,
    updatedAt: now,
  };
  bots.set(bot);
  bus.emit({ t: 'bot', bot });
  ensureDm(bot);
  return bot;
}

export function updateBot(id: string, patch: BotInput): Bot {
  const bot = bots.get(id);
  if (!bot) throw new HttpError(404, 'Bot not found');
  const renamed = patch.name !== undefined && patch.name.trim() !== bot.name;
  if (renamed) checkName(patch.name!.trim(), id);
  if (patch.projectId !== undefined && patch.projectId !== bot.projectId) assertWorkspaceIdle(dmOf(bot.id));
  const allowed: (keyof Bot)[] = [
    'name',
    'emoji',
    'color',
    'title',
    'description',
    'model',
    'effort',
    'permission',
    'allowRules',
    'askRules',
    'mcpServers',
    'plugins',
    'loadUserSettings',
    'projectId',
    'editScope',
    'monthlyBudgetUsd',
    'freshSession',
    'blindReview',
  ];
  for (const k of allowed) {
    if (patch[k] !== undefined) (bot as any)[k] = typeof patch[k] === 'string' ? (patch[k] as string).trim() : patch[k];
  }
  // An empty scope or budget means none.
  const scope = cleanScope(bot.editScope);
  if (scope) bot.editScope = scope;
  else delete bot.editScope;
  if (!bot.monthlyBudgetUsd) delete bot.monthlyBudgetUsd;
  if (!bot.freshSession) delete bot.freshSession;
  if (!bot.blindReview) delete bot.blindReview;
  bot.updatedAt = Date.now();
  bots.set(bot);
  bus.emit({ t: 'bot', bot });

  const dm = ensureDm(bot);
  let dmChanged = false;
  if (renamed) {
    dm.title = bot.name;
    dmChanged = true;
    // Every teammate's prompt lists names.
    for (const b of bots.all()) invalidateBot(b.id);
  }
  if (patch.projectId !== undefined && dm.projectId !== bot.projectId) {
    // The workspace belongs to the old project.
    detachWorkspace(dm);
    dm.projectId = bot.projectId;
    dm.sessions = {};
    dmChanged = true;
    invalidateChat(dm.id);
    const p = projects.get(bot.projectId);
    systemMessage(dm, p ? `Switched to project "${p.name}"` : 'Unlinked from the project');
  }
  if (dmChanged) {
    chats.set(dm);
    bus.emit({ t: 'chat', chat: dm });
  }
  invalidateBot(bot.id);
  return bot;
}

export function deleteBot(id: string) {
  const bot = bots.get(id);
  if (!bot) return;
  assertWorkspaceIdle(dmOf(id));
  for (const c of chats.all()) {
    if (c.kind === 'dm' && c.botIds[0] === id) deleteChat(c.id);
    else if (c.botIds.includes(id)) {
      c.botIds = c.botIds.filter((b) => b !== id);
      if (c.leadBotId === id) c.leadBotId = c.botIds[0] ?? null;
      delete c.sessions[id];
      delete c.cursors[id];
      chats.set(c);
      bus.emit({ t: 'chat', chat: c });
      systemMessage(c, `${bot.name} left the group`);
      invalidateChat(c.id);
    }
  }
  for (const r of routines.all()) {
    if (r.botId === id) {
      routines.delete(r.id);
      bus.emit({ t: 'routine_deleted', id: r.id });
    }
  }
  invalidateBot(id);
  fs.rmSync(memoryFile(id), { force: true });
  bots.delete(id);
  bus.emit({ t: 'bot_deleted', id });
}

export function createGroup(input: { title?: string; botIds: string[]; leadBotId?: string | null; projectId?: string | null }): Chat {
  const ids = [...new Set(input.botIds)].filter((id) => bots.has(id));
  if (ids.length < 1) throw new HttpError(400, 'Pick at least one bot');
  const chat = newChat({
    kind: 'group',
    title: input.title?.trim() || ids.map((id) => bots.get(id)!.name).join(', '),
    botIds: ids,
    leadBotId: input.leadBotId && ids.includes(input.leadBotId) ? input.leadBotId : ids[0],
    projectId: input.projectId ?? listProjects()[0]?.id ?? null,
  });
  chats.set(chat);
  bus.emit({ t: 'chat', chat });
  return chat;
}

type ChatPatch = Partial<Pick<Chat, 'title' | 'botIds' | 'leadBotId' | 'projectId' | 'pinned' | 'maxHops'>> & {
  /** The composer's switches; null goes back to each bot's own setting. */
  permission?: PermissionLevel | null;
  model?: string | null;
  effort?: Effort | null;
};

const LEVELS: PermissionLevel[] = ['auto', 'edits', 'ask', 'review', 'plan'];
const EFFORTS: Effort[] = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

export function updateChat(id: string, patch: ChatPatch): Chat {
  const chat = chats.get(id);
  if (!chat) throw new HttpError(404, 'Chat not found');
  let switches = false;
  if (patch.permission !== undefined) {
    if (patch.permission === null) delete chat.permission;
    else if (LEVELS.includes(patch.permission)) chat.permission = patch.permission;
    else throw new HttpError(400, 'Unknown permission mode');
    switches = true;
  }
  if (patch.model !== undefined) {
    if (patch.model === null) delete chat.model;
    else chat.model = String(patch.model).trim().slice(0, 200);
    switches = true;
  }
  if (patch.effort !== undefined) {
    if (patch.effort === null) delete chat.effort;
    else if (EFFORTS.includes(patch.effort)) chat.effort = patch.effort;
    else throw new HttpError(400, 'Unknown thinking effort');
    switches = true;
  }
  if (switches) applyChatSettings(chat.id);
  if (patch.projectId !== undefined && patch.projectId !== chat.projectId) assertWorkspaceIdle(chat);
  if (patch.title !== undefined && chat.kind === 'group') chat.title = patch.title.trim() || chat.title;
  if (patch.pinned !== undefined) chat.pinned = patch.pinned;
  if (patch.maxHops !== undefined) chat.maxHops = Math.max(0, Math.min(30, Math.round(patch.maxHops)));
  if (patch.botIds && chat.kind === 'group') {
    const ids = [...new Set(patch.botIds)].filter((b) => bots.has(b));
    if (!ids.length) throw new HttpError(400, 'A group needs at least one bot');
    const added = ids.filter((b) => !chat.botIds.includes(b));
    const removed = chat.botIds.filter((b) => !ids.includes(b));
    chat.botIds = ids;
    for (const b of added) chat.cursors[b] = chat.seq;
    for (const b of removed) {
      delete chat.sessions[b];
      delete chat.cursors[b];
      if (chat.context) delete chat.context[b];
    }
    if (!ids.includes(chat.leadBotId || '')) chat.leadBotId = ids[0];
    if (added.length) systemMessage(chat, `${added.map((b) => bots.get(b)!.name).join(', ')} joined the group`);
    if (removed.length) systemMessage(chat, `${removed.map((b) => bots.get(b)?.name || '').join(', ')} left the group`);
    invalidateChat(chat.id);
  }
  if (patch.leadBotId !== undefined && chat.botIds.includes(patch.leadBotId || '')) chat.leadBotId = patch.leadBotId;
  if (patch.projectId !== undefined && patch.projectId !== chat.projectId) {
    // The workspace belongs to the old project.
    detachWorkspace(chat);
    chat.projectId = patch.projectId;
    chat.sessions = {};
    chat.context = {};
    invalidateChat(chat.id);
    const p = projects.get(patch.projectId);
    systemMessage(chat, p ? `Switched to project "${p.name}"` : 'Unlinked from the project');
    if (chat.kind === 'dm') {
      const bot = bots.get(chat.botIds[0]);
      if (bot) {
        bot.projectId = patch.projectId;
        bots.set(bot);
        bus.emit({ t: 'bot', bot });
      }
    }
  }
  chats.set(chat);
  bus.emit({ t: 'chat', chat });
  return chat;
}

export function deleteChat(id: string) {
  const chat = chats.get(id);
  if (!chat) return;
  assertWorkspaceIdle(chat);
  forgetChat(id);
  detachWorkspace(chat);
  messages.deleteChat(id);
  deleteTurns(id);
  for (const r of routines.all()) {
    if (r.chatId === id) {
      r.chatId = null;
      routines.set(r);
      bus.emit({ t: 'routine', routine: r });
    }
  }
  chats.delete(id);
  bus.emit({ t: 'chat_deleted', id });
}

/** First launch: a starter project, the default team, and a group chat for them. */
export async function initIfNeeded() {
  if (settings.get().initialized) return;
  let project = listProjects()[0];
  if (!project) {
    try {
      project = await createProject({ name: 'My first site', template: 'static', folder: 'my-first-site' });
    } catch (e) {
      log.warn('Could not create the sample project:', (e as Error).message);
    }
  }
  const team: Bot[] = [];
  for (const t of DEFAULT_TEAM) {
    const existing = bots.all().find((b) => b.template === t);
    team.push(existing || createBot({ template: t, projectId: project?.id ?? null }));
  }
  if (!chats.all().some((c) => c.kind === 'group')) {
    const group = createGroup({ title: 'Web team', botIds: team.map((b) => b.id), leadBotId: team[0]?.id, projectId: project?.id ?? null });
    systemMessage(
      group,
      "Welcome to Crew! This is your web dev team. Just say what you need: Chief will break it down and @ teammates to split the work. You can also @Pixel, @Probe or @Lens directly. Type / to use skills; on the right are the project's live preview, files and terminal.",
      { uiOnly: true },
    );
  }
  settings.update({ initialized: true });
}
