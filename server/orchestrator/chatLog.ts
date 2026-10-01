import type { Bot, Chat, ChatMessage } from '../../shared/types';
import { bus } from '../bus';
import { bots, chats, messages, uid } from '../store';

export function preview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '[代码]')
    .replace(/[#>*_`~[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function setLastMessage(chat: Chat, msg: ChatMessage) {
  const author = msg.role === 'user' ? '你' : msg.role === 'system' ? '系统' : bots.get(msg.botId)?.name || '机器人';
  const text = msg.role === 'bot' && !msg.text && msg.error ? `⚠️ ${msg.error}` : preview(msg.text) || (msg.attachments?.length ? '[附件]' : '');
  chat.lastMessage = { text, ts: msg.ts, author };
  chat.updatedAt = msg.ts;
}

export function emitChat(chat: Chat) {
  chats.set(chat);
  bus.emit({ t: 'chat', chat });
}

export function systemMessage(chat: Chat, text: string, opts: { uiOnly?: boolean } = {}): ChatMessage {
  const msg: ChatMessage = { id: uid('m_'), chatId: chat.id, seq: ++chat.seq, ts: Date.now(), role: 'system', text, uiOnly: opts.uiOnly || undefined };
  messages.put(msg);
  bus.emit({ t: 'msg', msg });
  setLastMessage(chat, msg);
  emitChat(chat);
  return msg;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Bots @mentioned in the text, in order of first appearance. */
export function parseMentions(text: string, candidates: Bot[]): Bot[] {
  if (!candidates.length || !text.includes('@')) return [];
  const sorted = [...candidates].sort((a, b) => b.name.length - a.name.length);
  const re = new RegExp(`@(${sorted.map((b) => escapeRe(b.name)).join('|')})(?![A-Za-z0-9_-])`, 'gi');
  const found: Bot[] = [];
  // Mentions inside code are examples, not handoffs.
  const clean = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  for (const m of clean.matchAll(re)) {
    const bot = sorted.find((b) => b.name.toLowerCase() === m[1].toLowerCase());
    if (bot && !found.includes(bot)) found.push(bot);
  }
  return found;
}

export const ALL_RE = /@(所有人|全体|all|everyone)(?![A-Za-z0-9_-])/i;
