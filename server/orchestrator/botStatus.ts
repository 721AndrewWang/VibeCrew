import type { BotStatus } from '../../shared/types';
import { bus } from '../bus';

const statuses = new Map<string, BotStatus>();

export function botStatuses(): Record<string, BotStatus> {
  return Object.fromEntries(statuses);
}

export function setStatus(botId: string, status: Omit<BotStatus, 'since'>) {
  const prev = statuses.get(botId);
  if (prev && prev.state === status.state && prev.detail === status.detail && prev.chatId === status.chatId) return;
  const s = { ...status, since: prev?.state === status.state ? prev.since : Date.now() };
  statuses.set(botId, s);
  bus.emit({ t: 'bot_status', botId, status: s });
}
