import fs from 'node:fs';
import type { Bot, Chat } from '../shared/types';
import { bus } from './bus';
import { BOT_TEMPLATES, DEFAULT_ALLOW_RULES, DEFAULT_ASK_RULES, DEFAULT_TEAM } from './data/catalog';
import { bots, chats, messages, projects, routines, settings, uid } from './store';
import { createProject, HttpError, listProjects } from './projects';
import { forgetChat, invalidateBot, invalidateChat, systemMessage } from './orchestrator';
import { memoryFile } from './agents/prompts';
import { deleteTurns } from './agents/recorder';

const NAME_RE = /^[\p{L}\p{N}_-]{1,24}$/u;

function checkName(name: string, selfId?: string) {
  if (!NAME_RE.test(name)) throw new HttpError(400, '名字只能包含字母、数字、中文、下划线或连字符（最多 24 个字符），不能有空格');
  if (/^(所有人|全体|all|everyone)$/i.test(name)) throw new HttpError(400, '这个名字被 @所有人 占用了');
  const clash = bots.all().find((b) => b.id !== selfId && b.name.toLowerCase() === name.toLowerCase());
  if (clash) throw new HttpError(400, `已经有叫 ${name} 的机器人了`);
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

export function createBot(input: Partial<Bot> & { template?: string }): Bot {
  const tpl = BOT_TEMPLATES.find((t) => t.id === input.template);
  let name = (input.name ?? tpl?.name ?? '').trim();
  if (!name) throw new HttpError(400, '请填写名字');
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
    title: input.title?.trim() || tpl?.title || 'Web 开发助手',
    description: input.description?.trim() || tpl?.description || '',
    model: input.model ?? '',
    effort: input.effort ?? '',
    permission: input.permission || tpl?.permission || settings.get().defaultPermission,
    allowRules: input.allowRules ?? [...DEFAULT_ALLOW_RULES],
    askRules: input.askRules ?? [...DEFAULT_ASK_RULES],
    mcpServers: input.mcpServers ?? {},
    plugins: input.plugins ?? tpl?.plugins ?? [],
    loadUserSettings: input.loadUserSettings ?? true,
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

export function updateBot(id: string, patch: Partial<Bot>): Bot {
  const bot = bots.get(id);
  if (!bot) throw new HttpError(404, '机器人不存在');
  const renamed = patch.name !== undefined && patch.name.trim() !== bot.name;
  if (renamed) checkName(patch.name!.trim(), id);
  const allowed: (keyof Bot)[] = ['name', 'emoji', 'color', 'title', 'description', 'model', 'effort', 'permission', 'allowRules', 'askRules', 'mcpServers', 'plugins', 'loadUserSettings', 'projectId'];
  for (const k of allowed) {
    if (patch[k] !== undefined) (bot as any)[k] = typeof patch[k] === 'string' ? (patch[k] as string).trim() : patch[k];
  }
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
    dm.projectId = bot.projectId;
    dm.sessions = {};
    dmChanged = true;
    invalidateChat(dm.id);
    const p = projects.get(bot.projectId);
    systemMessage(dm, p ? `已切换到项目「${p.name}」` : '已解除项目绑定');
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
  for (const c of chats.all()) {
    if (c.kind === 'dm' && c.botIds[0] === id) deleteChat(c.id);
    else if (c.botIds.includes(id)) {
      c.botIds = c.botIds.filter((b) => b !== id);
      if (c.leadBotId === id) c.leadBotId = c.botIds[0] ?? null;
      delete c.sessions[id];
      delete c.cursors[id];
      chats.set(c);
      bus.emit({ t: 'chat', chat: c });
      systemMessage(c, `${bot.name} 离开了群聊`);
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
  if (ids.length < 1) throw new HttpError(400, '至少选择一个机器人');
  const chat = newChat({
    kind: 'group',
    title: input.title?.trim() || ids.map((id) => bots.get(id)!.name).join('、'),
    botIds: ids,
    leadBotId: input.leadBotId && ids.includes(input.leadBotId) ? input.leadBotId : ids[0],
    projectId: input.projectId ?? listProjects()[0]?.id ?? null,
  });
  chats.set(chat);
  bus.emit({ t: 'chat', chat });
  return chat;
}

export function updateChat(id: string, patch: Partial<Pick<Chat, 'title' | 'botIds' | 'leadBotId' | 'projectId' | 'pinned' | 'maxHops'>>): Chat {
  const chat = chats.get(id);
  if (!chat) throw new HttpError(404, '对话不存在');
  if (patch.title !== undefined && chat.kind === 'group') chat.title = patch.title.trim() || chat.title;
  if (patch.pinned !== undefined) chat.pinned = patch.pinned;
  if (patch.maxHops !== undefined) chat.maxHops = Math.max(0, Math.min(30, Math.round(patch.maxHops)));
  if (patch.botIds && chat.kind === 'group') {
    const ids = [...new Set(patch.botIds)].filter((b) => bots.has(b));
    if (!ids.length) throw new HttpError(400, '群聊里至少要有一个机器人');
    const added = ids.filter((b) => !chat.botIds.includes(b));
    const removed = chat.botIds.filter((b) => !ids.includes(b));
    chat.botIds = ids;
    for (const b of added) chat.cursors[b] = chat.seq;
    for (const b of removed) {
      delete chat.sessions[b];
      delete chat.cursors[b];
    }
    if (!ids.includes(chat.leadBotId || '')) chat.leadBotId = ids[0];
    if (added.length) systemMessage(chat, `${added.map((b) => bots.get(b)!.name).join('、')} 加入了群聊`);
    if (removed.length) systemMessage(chat, `${removed.map((b) => bots.get(b)?.name || '').join('、')} 离开了群聊`);
    invalidateChat(chat.id);
  }
  if (patch.leadBotId !== undefined && chat.botIds.includes(patch.leadBotId || '')) chat.leadBotId = patch.leadBotId;
  if (patch.projectId !== undefined && patch.projectId !== chat.projectId) {
    chat.projectId = patch.projectId;
    chat.sessions = {};
    invalidateChat(chat.id);
    const p = projects.get(patch.projectId);
    systemMessage(chat, p ? `已切换到项目「${p.name}」` : '已解除项目绑定');
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
  forgetChat(id);
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
      project = await createProject({ name: '我的第一个网站', template: 'static', folder: 'my-first-site' });
    } catch (e) {
      console.warn('[init] 无法创建示例项目：', (e as Error).message);
    }
  }
  const team: Bot[] = [];
  for (const t of DEFAULT_TEAM) {
    const existing = bots.all().find((b) => b.template === t);
    team.push(existing || createBot({ template: t, projectId: project?.id ?? null }));
  }
  if (!chats.all().some((c) => c.kind === 'group')) {
    const group = createGroup({ title: 'Web 小队', botIds: team.map((b) => b.id), leadBotId: team[0]?.id, projectId: project?.id ?? null });
    systemMessage(
      group,
      '欢迎来到 VibeCrew！这是你的 Web 开发小队。直接说需求，Chief 会拆解任务并 @ 队友分工；也可以 @Pixel、@Probe、@Lens 直接找人。输入 / 可以使用技能，右侧是项目的实时预览、文件和终端。',
      { uiOnly: true },
    );
  }
  settings.update({ initialized: true });
}
